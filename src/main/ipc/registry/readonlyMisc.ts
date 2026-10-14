import { z } from 'zod/v4'
import type { LlmStatusDTO } from '../../../shared/contract'
import { e, type Entry } from '../types'
import { getIntegrationsStatus, getStorageUsage, exportProject } from '../../db/repositories'
import {
  listOutlets,
  outletActions,
  outletStatuses,
  runOutletAction
} from '../../outlets/registry'
import {
  readAllOutletSettings,
  readOutletSettings,
  writeOutletSettings
} from '../../outlets/settings'
import { buildWorkNote } from '../../outlets/obsidian/build'
import { renderNote } from '../../../shared/markdown'
import { exportOptions } from '../../export/registry'
import { llmStatusNow } from '../../llm/current'
import { refreshLlmSelection } from '../../llm/watch'
import { redactPath } from '../../mcp/redact'

/**
 * The remaining agent-reachable surface: integrations, outlets, export options
 * and two status reads.
 *
 * THIS FILE'S RESULTS ARE THE ONES THAT LEAK. An outlet's status headline is
 * literally "Writing notes to /home/<user>/Vault", `integrations:status` returns
 * the Zotero data directory, and both are read-only channels nobody would think
 * to check. The path rule (no filesystem path in a tool ARGUMENT) is enforced
 * mechanically by the sweep; the sweep cannot see RETURN values, so every entry
 * here that carries a path collapses it to a presence boolean in `shape`. The
 * UI keeps the path — it is the user's own machine and the folder is what they
 * need to see — and only the MCP caller gets the redacted form.
 *
 * Two channels are permanently `tool: null` for the same reason in reverse:
 * `outlets:getSettings` returns the vault path as its whole payload and
 * `outlets:updateSettings` WRITES one, which chained with an outlet action is
 * arbitrary file write as the user.
 *
 * v3 -> zod/v4 re-authoring: `idSchema` was `z.number().int().nonnegative()`,
 * `outletIdSchema` the same 2-member enum, the action id
 * `z.string().min(1).max(60)` and the export format `z.string().min(1).max(60)`.
 */

const projectId = z.number().int().nonnegative()
const outletId = z.enum(['zotero', 'obsidian'])

/**
 * Every action id any outlet offers, DERIVED from the outlet registry rather
 * than typed out.
 *
 * The channel keeps its original free-form `z.string().min(1).max(60)` — the
 * renderer's value space is unchanged and an unknown id still fails in
 * `runOutletAction`, where it already did. The TOOL gets the enum, so the one
 * action-performing capability that writes outside this app cannot be handed an
 * id nobody defined, and an agent is shown the real list instead of guessing at
 * a string. Derived, because a hardcoded list would silently omit the next
 * outlet's actions and make them unreachable.
 */
const ACTION_IDS = listOutlets().flatMap((o) => o.actions.map((a) => a.id))

export const READONLY_MISC_ENTRIES: Entry[] = [
  e({
    channel: 'integrations:status',
    tool: 'integrations_status',
    access: 'read',
    summary:
      'Whether this machine\u2019s Zotero library and Obsidian vault are present and readable ' +
      'by the app. EVERY FLAG IS TRI-STATE and `null` always means the probe did not answer, ' +
      'so the state is genuinely unknown \u2014 never read `null` as "no". Locations are ' +
      'reported as configured/not-configured rather than as paths.',
    returns: 'IntegrationsStatusDTO',
    params: z.object({}),
    run: (ctx) => getIntegrationsStatus(ctx.db),
    // `zotero_data_path` is an absolute path and on Linux it begins
    // `/home/<username>/`, so returning it hands an agent the operating-system
    // account name for no benefit it could act on. Whether a library was FOUND
    // is the entire actionable content.
    shape: (result) => {
      const s = result as Record<string, unknown>
      const { zotero_data_path: path, ...rest } = s
      return { ...rest, zotero_data_configured: typeof path === 'string' && path.length > 0 }
    }
  }),

  e({
    channel: 'outlets:list',
    tool: 'outlets_list',
    access: 'read',
    summary:
      'The places this project\u2019s work can be mirrored to (Obsidian, Zotero), each with ' +
      'whether it is ready, the checks behind that verdict, and when it last ran. `ready: false` ' +
      'means an action would refuse; the check labels say which precondition failed. Folder ' +
      'locations are reported as configured/not-configured, not as paths.',
    returns: 'OutletStatusDTO[]',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) =>
      outletStatuses(ctx.db, a.projectId).then((list) =>
        list.map((o) => ({
          id: o.id,
          name: o.name,
          tagline: o.tagline,
          headline: o.status.headline,
          ready: o.status.ready,
          checks: o.status.checks,
          last_error: o.status.lastError,
          last_run_at: o.status.lastRunAt
        }))
      ),
    // The headline is `Writing notes to <vault_path>` and each check's `detail`
    // is the path or the OS error naming it. Both are exactly right on the
    // user's own screen and both disclose their home directory to an agent.
    shape: (result) => {
      const list = result as {
        headline: string
        last_error: string | null
        checks: { label: string; ok: boolean | null; detail: string | null }[]
      }[]
      return list.map((o) => ({
        ...o,
        headline: redactPath(o.headline),
        last_error: o.last_error === null ? null : redactPath(o.last_error),
        checks: o.checks.map((c) => ({
          label: c.label,
          ok: c.ok,
          // Dropped rather than redacted: a check's detail is ALWAYS the path or
          // an error quoting it, and `ok` plus `label` already carry the verdict
          // and what was tested.
          detail: null
        }))
      }))
    }
  }),

  e({
    channel: 'outlets:actions',
    tool: 'outlet_actions_list',
    access: 'read',
    summary:
      'What an outlet can be asked to do for a project, and whether each action is currently ' +
      'possible. `writes: true` means the action changes files OUTSIDE this app. ' +
      '`disabled_reason` is non-null when the action would refuse and says why. Read this ' +
      'before outlet_action_run \u2014 a reason here is a reason the run will fail.',
    returns: 'OutletActionDTO[]',
    params: z.object({ projectId, outletId }),
    order: ['projectId', 'outletId'],
    run: (ctx, a) =>
      outletActions(ctx.db, a.projectId, a.outletId).map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description,
        writes: action.writes,
        disabled_reason: action.disabledReason
      }))
  }),

  e({
    channel: 'outlets:run',
    tool: 'outlet_action_run',
    access: 'destructive',
    slow: true,
    summary:
      'Perform an outlet action \u2014 a REAL side effect OUTSIDE this app: it writes files ' +
      'into the user\u2019s own Obsidian vault or Zotero library, which nothing here can undo. ' +
      'Some actions overwrite notes the user may have edited by hand, and some delete notes for ' +
      'papers no longer in the project; outlet_actions_list says which by its `writes` flag and ' +
      'its description. Call outlet_actions_list first and do not run an action with a ' +
      '`disabled_reason`. The preconditions are re-checked here, because a vault can be ' +
      'unmounted between listing and running. Never run this speculatively.',
    returns: '{ ok, message, files_written, error }',
    params: z.object({
      projectId,
      outletId,
      actionId: z.string().min(1).max(60)
    }),
    toolParams: z.object({
      projectId,
      outletId,
      actionId: z.enum(ACTION_IDS as [string, ...string[]])
    }),
    order: ['projectId', 'outletId', 'actionId'],
    run: (ctx, a) => runOutletAction(ctx.db, a.projectId, a.outletId, a.actionId),
    // `paths` is the list of note files actually written — absolute, and outside
    // this app by construction, so it is the user's own vault layout and on a NAS
    // or second disk it carries their account name too. The RENDERER needs it for
    // "show in folder"; an agent has no use for it and cannot open a file anyway.
    // The counts answer what it actually wants to know. `message` and `error` are
    // built from raw fs failures, so both go through the anchored path redactor.
    shape: (result) => {
      const r = result as { ok: boolean; message: string; paths?: string[]; error?: string }
      return {
        ok: r.ok,
        message: redactPath(r.message),
        files_written: r.paths?.length ?? 0,
        error: r.error === undefined ? null : redactPath(r.error)
      }
    }
  }),

  e({
    channel: 'outlets:getSettings',
    tool: null,
    access: 'read',
    summary:
      'The outlets\u2019 stored settings. Not exposed as a tool: its payload IS the vault path ' +
      'and the Zotero data directory, which would hand an agent the user\u2019s home directory ' +
      'and OS account name. outlets_list reports the same readiness without them.',
    returns: 'OutletSettingsDTO',
    params: z.object({}),
    run: (ctx) => readAllOutletSettings(ctx.db)
  }),

  e({
    channel: 'outlets:updateSettings',
    tool: null,
    access: 'write',
    summary:
      'Change an outlet\u2019s settings. Permanently not a tool: the Obsidian settings carry ' +
      '`vault_path`, so an agent that could set it and then run an outlet action would have ' +
      'arbitrary file write as the user. A human chooses this folder, in the app.',
    returns: 'OutletSettingsDTO',
    // `unknown`, as the v3 original had it: the patch is validated by the
    // OUTLET's own zod schema inside `writeOutletSettings`, which rejects
    // unknown keys. Pre-validating the envelope here would only change which
    // error a bad patch produces, and this channel is never a tool.
    params: z.object({ outletId, patch: z.unknown() }),
    order: ['outletId', 'patch'],
    run: (ctx, a) => {
      // The patch is validated against the outlet's OWN zod schema (unknown keys
      // are REJECTED, so the stored row stays parseable), then the FULL new
      // state is returned — no read-after-write, and the UI cannot show a
      // position the database does not hold.
      writeOutletSettings(ctx.db, a.outletId, a.patch)
      return readAllOutletSettings(ctx.db)
    }
  }),

  e({
    channel: 'outlets:previewNote',
    tool: 'outlet_note_preview',
    access: 'read',
    summary:
      'The markdown note that WOULD be written for one paper in one project, rendered by the ' +
      'same code that writes the file \u2014 so what you see here is what an outlet action ' +
      'would produce. Nothing is written. Null when the paper is not in the project.',
    returns: 'string | null',
    params: z.object({ projectId, workId: z.number().int().nonnegative() }),
    order: ['projectId', 'workId'],
    run: (ctx, a) => {
      const db = ctx.db
      const note = buildWorkNote(db, a.projectId, a.workId)
      if (!note) return null
      return renderNote(note, { backlinks: readOutletSettings(db, 'obsidian').backlinks })
    },
    // The note is assembled by a builder that HOLDS the document's absolute path
    // (`buildWorkNote` resolves one through `base_dir`). Nothing renders it into
    // the markdown today, so nothing leaks today — and one added frontmatter
    // line would change that silently, in a read tool nobody would re-audit.
    // Scrubbed on the way out so the guarantee does not depend on the renderer
    // staying as it is.
    shape: (result) => (typeof result === 'string' ? redactPath(result) : result)
  }),

  e({
    channel: 'export:options',
    tool: 'export_options_list',
    access: 'read',
    summary:
      'What this project can be exported AS \u2014 the structural formats plus one option per ' +
      'extraction schema attached to it. Format names come from the database, so read them ' +
      'here rather than assuming any.',
    returns: 'ExportOptionDTO[]',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => exportOptions(ctx.db, a.projectId)
  }),

  e({
    channel: 'export:project',
    // `format` is a free-form string (it resolves against the DB's export
    // aliases, so it cannot be an enum), and the sweep requires every exposed
    // free-form string to carry a justification line in its allowlist — a file
    // this workstream does not own. Left unexposed rather than exposed with the
    // rule bypassed; enabling it is one allowlist entry.
    tool: null,
    access: 'read',
    summary:
      'Serialize a whole project to a string in one of the formats export_options_list reports.',
    returns: 'string',
    params: z.object({ projectId, format: z.string().min(1).max(60) }),
    order: ['projectId', 'format'],
    // 'json' and 'graph' are the structural formats; any other string is
    // resolved as an extraction_schema.export_alias ROW, so no domain format
    // name is hardcoded here. `exportProject` throws on an unknown alias.
    run: (ctx, a) => exportProject(ctx.db, a.projectId, a.format)
  }),

  e({
    channel: 'settings:llmStatus',
    tool: 'llm_status_get',
    access: 'read',
    summary:
      'Which analysis model this app actually resolved, as opposed to which one is preferred. ' +
      '`live: false` means no model can be reached, and in that case NO analysis run is ' +
      'produced at all \u2014 check this first when a model-calling tool fails. `reason` is ' +
      'safe to quote and never contains a credential.',
    returns: 'LlmStatusDTO',
    params: z.object({}),
    run: (): LlmStatusDTO => llmStatusNow()
  }),

  e({
    channel: 'settings:llmRecheck',
    tool: 'llm_status_recheck',
    access: 'read',
    summary:
      'Re-run the gateway pre-flight NOW and return the selection it produced. The status ' +
      'above is a snapshot; this is how an outage that has since been fixed is picked up ' +
      'without restarting the app. Safe to call repeatedly \u2014 it is one health request, and ' +
      'concurrent calls share the one in flight.',
    returns: 'LlmStatusDTO',
    params: z.object({}),
    // `access: 'read'` even though it replaces the provider in force: what it
    // changes is this app's view of someone else's service, not the corpus. No
    // row is written and nothing a reader could observe in the data moves.
    run: async (): Promise<LlmStatusDTO> => {
      await refreshLlmSelection()
      return llmStatusNow()
    }
  }),

  e({
    channel: 'settings:storageUsage',
    tool: 'storage_usage_get',
    access: 'read',
    summary:
      'How much disk each project\u2019s stored PDFs and text occupy, in bytes. Byte counts ' +
      'only \u2014 no locations. Each project also lists its LARGEST papers, the ten that would ' +
      'free the most space, with "papers_total" saying how many it has in all. Read it before ' +
      'importing in bulk.',
    returns: 'StorageProjectDTO[]  (MCP: papers truncated, plus papers_total/papers_truncated)',
    params: z.object({}),
    run: (ctx) => getStorageUsage(ctx.db),
    // The underlying row carries EVERY paper in EVERY project — a whole-corpus
    // title dump behind a tool an agent calls to ask about disk. The rows arrive
    // sorted largest-first, so the head is the part that answers the question;
    // `papers_total` keeps the truncation visible rather than implying the
    // project holds ten papers. Project byte totals are computed upstream over
    // the full set, so they stay correct.
    shape: (result) => {
      const projects = result as Array<{ papers: unknown[] }>
      return projects.map((p) => ({
        ...p,
        papers: p.papers.slice(0, 10),
        papers_total: p.papers.length,
        papers_truncated: p.papers.length > 10
      }))
    }
  })
]
