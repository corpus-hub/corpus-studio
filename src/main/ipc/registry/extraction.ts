import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import {
  listExtractionSchemas,
  createExtractionSchema,
  updateExtractionSchema,
  deleteExtractionSchema,
  createExtractionField,
  updateExtractionField,
  deleteExtractionField,
  reorderExtractionFields,
  exportSchemaBundle,
  importSchemaBundle,
  listProjectSchemas,
  attachProjectSchema,
  detachProjectSchema,
  getSchemaCoverage,
  getExtractionRows,
  countExtractionRows,
  getExtractionStatusSummary
} from '../../db/repositories'
import { currentParagraphInventory, preferredDocumentId } from '../../db/repos/text'
import { SCHEMA_PRESETS, SCHEMA_BUNDLE_FORMAT } from '../../db/schemaPresets'
import { runPipelineToDto } from '../../llm/pipeline'
import { getLlmProvider } from '../../llm/current'
import { trackBusy } from '../../busy'
import { cap, capOffset, CLAMP } from '../clamp'
import { listScope, scopeNote } from '../result'
import { withProjectContext } from '../projectContext'
import { cropsForWork } from '../../pipeline/tableCrops'

/**
 * Extraction — the definitions of WHAT to extract, and the values extracted.
 *
 * Schemas belong to the APP, not to a project (migration v5), so none of the
 * `schemas:*` channels takes a project id: there is one definition list,
 * reachable with no project open. WHICH schemas a project applies lives in
 * `project_schema` and is served by `projectSchemas:*`. DETACHING IS NOT
 * DELETING — a detached schema keeps its definition and every measurement ever
 * extracted under it.
 *
 * v3 -> zod/v4 re-authoring, field for field: `idSchema` was
 * `z.number().int().nonnegative()`; `fieldTypeSchema` the same 4-member enum;
 * `schemaInputSchema` `{ name: string.min(1).max(200), description:
 * string.max(2000).nullish() }` (no `key`, no `version` — the key is slugified
 * from the name and the version hashed from the fields, so accepting either
 * from a caller would let it assert an identity it does not own);
 * `fieldInputSchema` and the bundle schemas reproduced with their exact caps and
 * their exact `.nullish()` vs `.nullable()` split, which is deliberate and not
 * unified here.
 */

const nowIso = (): string => new Date().toISOString()

const projectId = z.number().int().nonnegative()
const schemaId = z.number().int().nonnegative()

const fieldTypeSchema = z.enum(['number', 'text', 'enum', 'boolean'])

const schemaInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish()
})

const fieldInputSchema = z.object({
  key: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(200),
  data_type: fieldTypeSchema,
  unit: z.string().max(60).nullish(),
  required: z.boolean().optional(),
  enum_options: z.array(z.string().min(1).max(120)).max(64).nullish(),
  description: z.string().max(2000).nullish(),
  sort_order: z.number().int().min(0).max(10_000).optional()
})

const bundleFieldSchema = z.object({
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  data_type: fieldTypeSchema,
  unit: z.string().max(60).nullable(),
  required: z.boolean(),
  enum_options: z.array(z.string().min(1).max(120)).max(64).nullable(),
  description: z.string().max(2000).nullable()
})

const bundleSchema = z.object({
  format: z.number().int().min(1),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  fields: z.array(bundleFieldSchema).max(200)
})

const page = {
  limit: z.number().int().min(1).nullish(),
  offset: z.number().int().min(0).nullish()
}

export const EXTRACTION_ENTRIES: Entry[] = [
  // ---------- schema definitions (GLOBAL) ----------
  e({
    channel: 'schemas:list',
    tool: 'schemas_list',
    access: 'read',
    summary:
      'Every extraction schema defined in this install \u2014 the user\u2019s definitions of ' +
      'WHAT to pull out of papers, with each schema\u2019s fields (label, data type, unit, ' +
      'whether required, allowed values). Schemas are global, not per project; which ones a ' +
      'project applies is project_schemas_list. Read this before extraction_rows_get so you ' +
      'know what the columns mean.',
    returns: 'ExtractionSchemaDTO[]',
    params: z.object({}),
    run: (ctx) => listExtractionSchemas(ctx.db)
  }),

  e({
    channel: 'schemas:create',
    // DELIBERATELY NOT A TOOL, for the same reason `projects:create` is not one.
    // A schema is a scientist's standing statement about what matters in their
    // literature, and every measurement extracted afterwards is filed under it.
    // An agent that invents or edits one does not add data — it silently changes
    // the question the whole corpus was read against, and the papers already
    // extracted go stale rather than wrong, so nothing announces it. Reading and
    // APPLYING schemas is exposed; authoring them stays with the human.
    tool: null,
    access: 'write',
    summary:
      'Define a new, empty extraction schema by name. ' +
      'The schema\u2019s key is derived from the name and its version is hashed from its ' +
      'fields, so neither can be supplied. A schema is a statement about what matters in this ' +
      'literature \u2014 do not invent one that was not asked for. Returns the created schema.',
    returns: 'ExtractionSchemaDTO',
    params: schemaInputSchema,
    run: (ctx, a) => createExtractionSchema(ctx.db, a, nowIso())
  }),

  e({
    channel: 'schemas:update',
    // DELIBERATELY NOT A TOOL, for the same reason `projects:create` is not one.
    // A schema is a scientist's standing statement about what matters in their
    // literature, and every measurement extracted afterwards is filed under it.
    // An agent that invents or edits one does not add data — it silently changes
    // the question the whole corpus was read against, and the papers already
    // extracted go stale rather than wrong, so nothing announces it. Reading and
    // APPLYING schemas is exposed; authoring them stays with the human.
    tool: null,
    access: 'write',
    summary:
      'Rename an extraction schema or change its description. Does not touch its fields or any ' +
      'value already extracted under it. Returns the updated schema.',
    returns: 'ExtractionSchemaDTO',
    params: z.object({ schemaId, input: schemaInputSchema }),
    order: ['schemaId', 'input'],
    run: (ctx, a) => updateExtractionSchema(ctx.db, a.schemaId, a.input, nowIso())
  }),

  e({
    channel: 'schemas:delete',
    tool: 'schema_delete',
    access: 'destructive',
    summary:
      'DELETE an extraction schema and all of its field definitions. Measurements already ' +
      'extracted under it SURVIVE but lose the field that gave them meaning, and there is no ' +
      'way to reattach them \u2014 the definition a scientist wrote is gone and must be ' +
      'retyped. To stop a project applying a schema WITHOUT destroying anything, use ' +
      'project_schema_detach instead. Returns the remaining schemas.' +
      'If this call times out or your connection drops the write is NOT rolled back \u2014 ' +
      'read the state back before retrying.',
    returns: 'ExtractionSchemaDTO[]',
    params: z.object({ schemaId }),
    order: ['schemaId'],
    run: (ctx, a) => deleteExtractionSchema(ctx.db, a.schemaId)
  }),

  e({
    channel: 'schemas:addField',
    // DELIBERATELY NOT A TOOL, for the same reason `projects:create` is not one.
    // A schema is a scientist's standing statement about what matters in their
    // literature, and every measurement extracted afterwards is filed under it.
    // An agent that invents or edits one does not add data — it silently changes
    // the question the whole corpus was read against, and the papers already
    // extracted go stale rather than wrong, so nothing announces it. Reading and
    // APPLYING schemas is exposed; authoring them stays with the human.
    tool: null,
    access: 'write',
    summary:
      'Add one field to an extraction schema: what it is called, its data type ' +
      '(number/text/enum/boolean), its unit, whether it is required, and for an enum its ' +
      'allowed values. Adding a field changes the schema\u2019s version, so papers extracted ' +
      'under the older version are marked stale rather than silently treated as current. ' +
      'Returns the updated schema.',
    returns: 'ExtractionSchemaDTO',
    params: z.object({ schemaId, input: fieldInputSchema }),
    order: ['schemaId', 'input'],
    run: (ctx, a) => createExtractionField(ctx.db, a.schemaId, a.input, nowIso())
  }),

  e({
    channel: 'schemas:updateField',
    // DELIBERATELY NOT A TOOL, for the same reason `projects:create` is not one.
    // A schema is a scientist's standing statement about what matters in their
    // literature, and every measurement extracted afterwards is filed under it.
    // An agent that invents or edits one does not add data — it silently changes
    // the question the whole corpus was read against, and the papers already
    // extracted go stale rather than wrong, so nothing announces it. Reading and
    // APPLYING schemas is exposed; authoring them stays with the human.
    tool: null,
    access: 'write',
    summary:
      'Change one field of an extraction schema \u2014 its label, type, unit, requiredness, ' +
      'allowed values or position. Changes the schema\u2019s version, so already-extracted ' +
      'papers are marked stale rather than reinterpreted under the new definition. Returns the ' +
      'updated schema.',
    returns: 'ExtractionSchemaDTO',
    params: z.object({ fieldId: z.number().int().nonnegative(), input: fieldInputSchema }),
    order: ['fieldId', 'input'],
    run: (ctx, a) => updateExtractionField(ctx.db, a.fieldId, a.input, nowIso())
  }),

  e({
    channel: 'schemas:deleteField',
    tool: 'schema_field_delete',
    access: 'destructive',
    summary:
      'DELETE one field from an extraction schema. The field definition is gone and must be ' +
      'retyped by hand; values already extracted into it survive but no longer have a field ' +
      'describing them. An extraction already running keeps the old field list and will write ' +
      'into a field that no longer exists. Returns the updated schema.' +
      'If this call times out or your connection drops the write is NOT rolled back \u2014 ' +
      'read the state back before retrying.',
    returns: 'ExtractionSchemaDTO',
    params: z.object({ fieldId: z.number().int().nonnegative() }),
    order: ['fieldId'],
    run: (ctx, a) => deleteExtractionField(ctx.db, a.fieldId)
  }),

  e({
    channel: 'schemas:reorderFields',
    // A TOOL, unlike every other schemas:* write above them. Those change what
    // the model is asked for and mark extracted papers stale; this one moves a
    // column on screen and cannot touch a recorded value or a schema version, so
    // there is nothing here for an agent to silently change the meaning of.
    tool: 'schema_fields_reorder',
    access: 'write',
    summary:
      'Set the order the fields of an extraction schema are read in \u2014 the column order in ' +
      'the Extraction table and the line order in a paper\u2019s readings. PRESENTATION ONLY: no ' +
      'extracted value changes, the schema version does not move, and nothing already extracted ' +
      'becomes stale. `fieldIds` must name EVERY field of the schema exactly once; a partial ' +
      'list is refused rather than appended to, because the fields left out would land at ' +
      'positions nobody chose. Returns the updated schema with its fields in the new order.',
    returns: 'ExtractionSchemaDTO',
    params: z.object({
      schemaId,
      fieldIds: z.array(z.number().int().nonnegative()).max(200)
    }),
    order: ['schemaId', 'fieldIds'],
    run: (ctx, a) => reorderExtractionFields(ctx.db, a.schemaId, a.fieldIds, nowIso())
  }),

  e({
    channel: 'schemas:presets',
    tool: 'schema_presets_list',
    access: 'read',
    summary:
      'The premade extraction schemas this app ships with, as importable bundles. Nothing is ' +
      'read from the database and nothing is created \u2014 a person imports one in the app to ' +
      'make it real. Use this to see what vocabulary this app already has for a field before ' +
      'assuming none exists.',
    returns: 'SchemaBundleDTO[]',
    params: z.object({}),
    run: () => SCHEMA_PRESETS
  }),

  e({
    channel: 'schemas:export',
    tool: 'schema_export',
    access: 'read',
    summary:
      'One extraction schema as a portable bundle: its name, description and every field ' +
      'definition, with no extracted data and no ids. This is the shareable form \u2014 hand it ' +
      'to a colleague, who imports it in their own copy of the app.',
    returns: 'SchemaBundleDTO',
    params: z.object({ schemaId }),
    order: ['schemaId'],
    run: (ctx, a) => exportSchemaBundle(ctx.db, a.schemaId)
  }),

  e({
    channel: 'schemas:import',
    // DELIBERATELY NOT A TOOL, for the same reason `projects:create` is not one.
    // A schema is a scientist's standing statement about what matters in their
    // literature, and every measurement extracted afterwards is filed under it.
    // An agent that invents or edits one does not add data — it silently changes
    // the question the whole corpus was read against, and the papers already
    // extracted go stale rather than wrong, so nothing announces it. Reading and
    // APPLYING schemas is exposed; authoring them stays with the human.
    tool: null,
    access: 'write',
    summary:
      'Create a new extraction schema from a bundle (one from schema_presets_list, or one ' +
      'schema_export produced elsewhere). ALWAYS CREATES; it never overwrites or merges into an ' +
      'existing schema. A bundle written by a newer version of the app is refused with a ' +
      'message saying so rather than partially read. Returns the created schema.',
    returns: 'ExtractionSchemaDTO',
    params: bundleSchema,
    run: (ctx, a) => {
      // Checked against a MAXIMUM, not for equality. A bundle written by an
      // older app stays readable — that is the whole point of a monotonic format
      // number — while one from a newer app is refused with a sentence the user
      // can act on instead of a validation error naming a field they cannot see.
      if (a.format > SCHEMA_BUNDLE_FORMAT) {
        throw new Error(
          `This schema was shared by a newer version of the app (format ${a.format}; ` +
            `this one reads up to ${SCHEMA_BUNDLE_FORMAT}). Update, then import it again.`
        )
      }
      return importSchemaBundle(ctx.db, a, nowIso())
    }
  }),

  // ---------- per-project schema attachments ----------
  e({
    channel: 'projectSchemas:list',
    tool: 'project_schemas_list',
    access: 'read',
    summary:
      'The extraction schemas a project applies \u2014 the subset of the global schema list its ' +
      'Extraction view uses. A schema missing from here still exists and still holds its data; ' +
      'it is simply not applied in this project.',
    returns: 'ExtractionSchemaDTO[]',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => listProjectSchemas(ctx.db, a.projectId)
  }),

  e({
    channel: 'projectSchemas:attach',
    tool: 'project_schema_attach',
    access: 'write',
    summary:
      'Apply a global extraction schema to a project, so its Extraction view and its future ' +
      'extraction runs use it. Does not extract anything by itself. Returns the project\u2019s ' +
      'attached schemas. If this call times out or your connection drops the write is NOT ' +
      'rolled back \u2014 read the state back before retrying.',
    returns: 'ExtractionSchemaDTO[]',
    params: z.object({ projectId, schemaId }),
    order: ['projectId', 'schemaId'],
    run: (ctx, a) => attachProjectSchema(ctx.db, a.projectId, a.schemaId, nowIso())
  }),

  e({
    channel: 'projectSchemas:detach',
    tool: 'project_schema_detach',
    access: 'write',
    summary:
      'Stop a project applying an extraction schema. DETACHING IS NOT DELETING: the schema ' +
      'definition survives, and every value already extracted under it in this project survives ' +
      'and stays readable. This is the reversible way to remove a schema from a project. ' +
      'Returns the project\u2019s remaining attached schemas.' +
      'If this call times out or your connection drops the write is NOT rolled back \u2014 ' +
      'read the state back before retrying.',
    returns: 'ExtractionSchemaDTO[]',
    params: z.object({ projectId, schemaId }),
    order: ['projectId', 'schemaId'],
    run: (ctx, a) => detachProjectSchema(ctx.db, a.projectId, a.schemaId)
  }),

  e({
    channel: 'projectSchemas:coverage',
    tool: 'schema_coverage_get',
    access: 'read',
    summary:
      'How much of a project each attached extraction schema actually covers: how many papers ' +
      'have values under it and how many do not. Use it to tell "this schema found nothing" ' +
      'from "this schema was never run on these papers".',
    returns: 'SchemaCoverageDTO[]',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getSchemaCoverage(ctx.db, a.projectId)
  }),

  // ---------- extracted values ----------
  e({
    channel: 'extraction:rows',
    tool: 'extraction_rows_get',
    access: 'read',
    summary:
      'The values extracted from a project\u2019s papers: quantity, number, unit, the ' +
      'conditions it was measured under, the fact kind, and the evidence span ' +
      'quoted from the paper. Pass `workId` to restrict to one paper. ONE MEASURED VALUE CAN ' +
      'LEGITIMATELY APPEAR TWICE, under two different schemas that both asked for it \u2014 ' +
      'that is not duplication and must not be deduplicated; the schema linkage on each row ' +
      'says which reading it is. `fact_kind` says how the value was arrived at ' +
      '(directly-reported, inferred, supplied-by-project-context, ' +
      'uncertain-conflicting) and only "directly-reported" means ' +
      'the paper stated it. Each row carries the evidence span it came from, and a span with ' +
      '`verbatim: false` means the model asserted that wording and it could NOT be found in the ' +
      'document \u2014 never quote such a span as something the paper says. Paginated: `total` ' +
      'counts the whole project, or just the one paper when you pass `workId`.',
    returns: 'ExtractionRowDTO[]  (MCP: a ListScope, plus project_context for a one-paper read)',
    params: z.object({
      projectId,
      // MCP-only in practice: the preload forwards `(projectId)` alone, so this
      // is absent for every UI call and the repository sees its unpaged default.
      workId: z.number().int().nonnegative().nullish(),
      ...page
    }),
    order: ['projectId'],
    run: (ctx, a) =>
      // UNPAGED when a `workId` was asked for, and that is deliberate. The
      // repository pages in SQL over the WHOLE project ordered by title, so
      // slicing first and filtering to one paper afterwards would return an
      // empty page — and a confident "this paper has no extracted values" — for
      // any paper whose title sorts past the page. That is a read hiding data,
      // which is the one thing these reads may never do. The repository has no
      // work_id predicate to push the filter into, so the honest fix is to read
      // the project's rows and slice AFTER filtering; the row cap then applies
      // to what was actually requested.
      getExtractionRows(
        ctx.db,
        a.projectId,
        a.workId !== null && a.workId !== undefined
          ? {}
          : a.limit === null || a.limit === undefined
            ? {}
            : { limit: a.limit, offset: a.offset ?? 0 }
      ),
    clampArgs: (a) => ({
      ...a,
      limit: cap(a.limit, CLAMP.limit),
      offset: capOffset(a.offset)
    }),
    shape: (result, ctx, a) => {
      const rows = result as { work_id: number }[]
      const perWork = a.workId !== null && a.workId !== undefined
      // Filtering to the paper the caller ASKED FOR is not hiding data — the
      // filter IS the request — provided the total then describes what was
      // asked for. A project-wide count beside a one-paper list would tell an
      // agent it had seen part of that paper's rows when it had seen all of them.
      const matched = perWork ? rows.filter((r) => r.work_id === a.workId) : rows
      const total = perWork ? matched.length : countExtractionRows(ctx.db, a.projectId)
      const offset = perWork ? (a.offset ?? 0) : 0
      const items = perWork
        ? matched.slice(offset, offset + (a.limit ?? CLAMP.limit))
        : matched
      // The background is attached only for a ONE-PAPER read. Project-wide rows
      // span every paper, and `buildDossierContext` selects and excludes entries
      // relative to ONE target paper — there is no target here to select for, and
      // picking one arbitrarily would label the wrong paper's background.
      return withProjectContext(listScope(items, total, {
        note:
          total === 0
            ? perWork
              ? `Paper ${a.workId} has no extracted values in project ${a.projectId}. It may not ` +
                'be in this project, or extraction may not have run on it \u2014 check ' +
                'schema_coverage_get.'
              : `Project ${a.projectId} has no extracted values yet. Run extraction with ` +
                'paper_extract_run, or check schema_coverage_get.'
            : items.length === 0
              ? scopeNote.filteredOut(total, a.projectId)
              : null,
        counts: null,
        limit: a.limit ?? null,
        offset: a.offset ?? 0
      }), ctx, a.projectId, perWork ? a.workId : null)
    }
  }),

  e({
    channel: 'extraction:crops',
    tool: null,
    // NO agent tool. This returns base64 PNGs — hundreds of kilobytes — which is
    // exactly what an agent's context must not be filled with. An agent that
    // wants to know what a table says has `paper_text_find`; the pictures exist
    // for a HUMAN reviewer, whose screen can hold them.
    access: 'read',
    summary:
      'The table pictures a paper\u2019s extraction was read off, rendered by the same code ' +
      'path that put them in the extractor\u2019s prompt.',
    returns: 'TableCropsDTO',
    params: z.object({
      workId: z.number().int().positive(),
      /** Wording to MARK on the pictures — the passage an extraction cited. */
      quote: z.string().nullish()
    }),
    run: async (ctx, a) => {
      const crops = await cropsForWork(ctx.db, a.workId, () => {}, a.quote)
      return {
        // Base64 because the contextBridge structured-clones: a Buffer arrives
        // in the renderer as a plain object of numeric keys.
        images: crops.images.map((i) => ({
          png: i.png.toString('base64'),
          caption: i.caption ?? null,
          page: i.page,
          label: i.label,
          widthPx: i.widthPx,
          heightPx: i.heightPx,
          marks: i.marks ?? []
        })),
        found: crops.found,
        quotePages: crops.quotePages,
        unavailable: crops.unavailable
      }
    }
  }),

  e({
    channel: 'extraction:summary',
    tool: 'extraction_status_get',
    access: 'read',
    // The same channel serves the Review screen's counts. Two tools cannot share
    // one channel (tool names are unique per entry), and this is the honest
    // name: it is the extraction status, which is also what tells you the review
    // queue's shape.
    summary:
      'Counts describing a project\u2019s extraction and review state: how many values were ' +
      'auto-validated, how many are awaiting human judgement, how many are structurally ' +
      'invalid or in conflict, and the quality-control sample. Read this BEFORE ' +
      'review_queue_get so you know the queue\u2019s true size rather than inferring it from a ' +
      'page.',
    returns: 'ExtractionStatusSummaryDTO',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => getExtractionStatusSummary(ctx.db, a.projectId)
  }),

  // ---------- run an analysis ----------
  e({
    channel: 'analysis:run',
    tool: 'paper_extract_run',
    access: 'write',
    slow: true,
    summary:
      'Run an analysis over ONE paper with the model and store the result with full provenance. ' +
      'READS THE PAPER\u2019S TITLE AND ABSTRACT ONLY \u2014 not its full text. If the abstract ' +
      'is empty it falls back to the paper\u2019s extracted paragraphs, and if there is no prose ' +
      'at all it REFUSES rather than analysing a bare title. FOR FULL-TEXT EXTRACTION THIS IS ' +
      'THE WRONG TOOL \u2014 full-text extraction is the "schema-extract" pipeline stage, which ' +
      'runs on import and is re-run from the app; there is no tool for it yet. Never report a ' +
      'result from this tool as a full-text extraction. SYNCHRONOUS \u2014 it returns the ' +
      'finished run and there is NO job to poll. Pass projectId 0 for an analysis that belongs ' +
      'to no project, or a real project id for one interpreted under that project\u2019s ' +
      'question; project interpretation is never stored globally. THE ANALYSIS TYPES "dossier" ' +
      'AND "ranking" ARE REFUSED AT projectId 0 \u2014 both are a project\u2019s own reading and ' +
      'need a real project id. Optional schemaId makes the ' +
      'run extract that schema\u2019s fields. This SUPERSEDES the previous current run for the ' +
      'same paper, project, analysis type and schema and inserts the new one in a single ' +
      'transaction, so there is never more than one current run \u2014 but the background ' +
      'pipeline may be extracting the same paper at the same time, and whichever finishes last ' +
      'wins. Check jobs_list for this project first if the pipeline may be running. If this ' +
      'call times out ' +
      'the run may STILL BE RUNNING and the write is NOT rolled back \u2014 read ' +
      'paper_analyses_list back rather than retrying.',
    returns: 'AnalysisRunDTO',
    params: z
      .object({
        workId: z.number().int().nonnegative(),
        projectId,
        // 'summary' is NOT here. It shares this endpoint's storage key
        // (work, project, 'summary', schema_id=0) with the prose summaries, but
        // it runs the FACT pipeline — so a re-run through this path would
        // supersede a prose summary with a run carrying no `work_summary` row,
        // and the summary modal would report a failure that never happened.
        // Summaries have their own endpoint, `summary:generate`.
        analysisType: z.enum([
          'extraction',
          'classification',
          'ranking',
          'measurement',
          'relation',
          'dossier'
        ]),
        // Optional target extraction schema — makes the run schema-driven.
        schemaId: z.number().int().nonnegative().optional()
      })
      // A 'dossier' or 'ranking' run is a PROJECT'S reading — of a reference
      // set, of a project's own question — and storing one at `project_id = 0`
      // would serve one project's framing to every other as though it were the
      // paper's own claim. That is the failure HARD RULE 3's work/project split
      // exists to prevent, and `summary:generate` already refuses its own
      // version of it. Refused rather than corrected: there is no way to guess
      // which project was meant.
      .refine((v) => !['dossier', 'ranking'].includes(v.analysisType) || v.projectId > 0, {
        message:
          "analysis types 'dossier' and 'ranking' are a project's reading and need a real " +
          'project id; 0 is the global sentinel',
        path: ['projectId']
      }),
    run: async (ctx, a) => {
      const db = ctx.db
      const wrow = db
        .prepare('SELECT title, abstract FROM work WHERE id = ?')
        .get(a.workId) as { title: string; abstract: string | null } | undefined
      if (!wrow) throw new Error(`work ${a.workId} not found`)

      // A TITLE IS NOT A PAPER. Unguarded, a work whose abstract is empty is
      // extracted from its title alone — and what comes back is entirely the
      // model's prior about papers with that name, stored with full provenance
      // and reading exactly like an extraction from real text.
      //
      // Refusing on an empty abstract ALONE would be its own bug, and a louder
      // one: nothing fills in `work.abstract` for a PDF imported as a file, so a
      // paper whose full text is extracted and on screen has none, and the
      // refusal would name the very PDF the user just ingested. So the paragraph
      // inventory is consulted first and used when it has prose. The refusal is
      // reached only when there is genuinely nothing — which is exactly when
      // `summary.ts` refuses too (`NoSourceTextError`), so the same paper is
      // declined by both paths or read by both, never invented by one.
      const abstract = (wrow.abstract ?? '').trim()
      let docText = [wrow.title, abstract].filter(Boolean).join('\n\n')
      if (abstract.length === 0) {
        const documentId = preferredDocumentId(db, a.workId)
        const inventory = documentId === null ? null : currentParagraphInventory(db, documentId)
        const body = (inventory?.paragraphs ?? [])
          .filter((p) => p.kind !== 'reference' && typeof p.text === 'string' && p.text.trim())
          .map((p) => p.text as string)
          .join('\n\n')
        if (body.trim().length === 0) {
          const doc =
            documentId === null
              ? undefined
              : (db
                  .prepare('SELECT content_status FROM document WHERE id = ?')
                  .get(documentId) as { content_status: string } | undefined)
          throw new Error(
            `This paper has no text to analyse — only its title` +
              `${doc ? ` (its document is ${doc.content_status})` : ''}. ` +
              `Ingest the PDF, or add an abstract, before running an analysis.`
          )
        }
        docText = [wrow.title, body].filter(Boolean).join('\n\n')
      }
      // Counted as busy: this runs the pipeline OUTSIDE the job queue, so the
      // close guard would otherwise see an idle queue and wave the user through
      // a quit that discards the analysis they are watching run.
      // Attributed to the WINDOW that asked (null over MCP, which has none), so
      // closing that one window of several still prompts about its own work.
      return trackBusy(
        () =>
          runPipelineToDto(
            db,
            getLlmProvider(),
            {
              workId: a.workId,
              projectId: a.projectId,
              analysisType: a.analysisType,
              docText,
              schemaId: a.schemaId ?? null
            },
            nowIso()
          ),
        ctx.sender?.id ?? null
      )
    },
    // The unshaped run carries every fact with its full evidence span and check
    // list, which for a rich paper is megabytes. Facts are TRUNCATED, never
    // filtered, and the count of what was cut travels with them so nothing goes
    // missing silently. `verbatim` is preserved on every span it is on.
    //
    // The two lists are cut TOGETHER, not independently: the run-level
    // `evidence` array is sliced to the spans the retained facts actually cite,
    // because handing back a claim whose citation fell off the end of a
    // separately-truncated list is worse than handing back fewer claims. Each
    // retained fact carries its own span inline regardless, so a kept claim is
    // never left uncitable.
    shape: (result) => {
      const run = result as { facts?: unknown[]; evidence?: unknown[] } | null
      if (!run) return run
      const facts = Array.isArray(run.facts) ? run.facts : []
      const evidence = Array.isArray(run.evidence) ? run.evidence : []
      const keptFacts = facts.slice(0, CLAMP.limit) as { evidence?: { id?: number } | null }[]
      const citedIds = new Set(
        keptFacts.map((f) => f.evidence?.id).filter((id): id is number => typeof id === 'number')
      )
      const keptEvidence =
        facts.length > CLAMP.limit
          ? (evidence as { id?: number }[]).filter(
              (span) => typeof span.id === 'number' && citedIds.has(span.id)
            )
          : evidence.slice(0, CLAMP.limit)
      return {
        ...run,
        source_text: 'title-and-abstract',
        source_note:
          'This run read the paper\u2019s title and abstract (or, when the abstract was empty, ' +
          'its extracted paragraphs) \u2014 not necessarily its full text. Do not present it ' +
          'as a full-text extraction. An evidence span with verbatim: false means the model ' +
          'asserted that wording and it could NOT be found in the document \u2014 never quote ' +
          'it as something the paper says.',
        facts: keptFacts,
        facts_total: facts.length,
        facts_truncated: facts.length > CLAMP.limit,
        evidence: keptEvidence,
        evidence_total: evidence.length,
        evidence_truncated: keptEvidence.length < evidence.length
      }
    }
  })
]
