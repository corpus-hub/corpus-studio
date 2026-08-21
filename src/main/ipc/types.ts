import { z } from 'zod/v4'
import type { DB } from '../db/connection'

/**
 * One capability, defined ONCE.
 *
 * An `Entry` is simultaneously an `ipcMain.handle` registration and an MCP tool
 * definition. That is the whole point: the alternative is 70-odd tool schemas
 * hand-maintained beside 70-odd zod schemas, which drift the first time a filter
 * is added to one and not the other.
 *
 * IMPORTS NO ELECTRON, and nothing here may. `Ctx.sender` is a plain
 * `{ id: number } | null` rather than a `BrowserWindow` so this file — and every
 * registry file that imports it — loads outside an Electron main process.
 *
 * SCHEMAS ARE `zod/v4`, not the app's classic v3. Verified by running it:
 * `z.toJSONSchema` on a v3 schema object throws
 * `TypeError: Cannot read properties of undefined (reading 'def')`, so a
 * migrated schema is RE-AUTHORED against the v3 original rather than lifted.
 * Field for field, same value space; see `docs/plans/2026-07-28-mcp-connector.md`
 * §2.2 for what that review has to check.
 */

/**
 * What a capability does to the corpus, and therefore who may call it.
 *
 * - `read` — cannot change anything.
 * - `write` — records verdicts, imports, overrides, re-runs. Additive or
 *   correcting; nothing it does is unrecoverable.
 * - `destructive` — removes something a user would have to recreate by hand, or
 *   writes outside this app (an outlet action writes files).
 *
 * The MCP layer filters on this. It is NOT a hint: a tool above the enabled
 * level is neither registered nor listed, so an agent never plans around a tool
 * it will then be refused.
 */
export type Access = 'read' | 'write' | 'destructive'

/**
 * Everything a handler body is allowed to reach for.
 *
 * `db` is ALWAYS the one shared connection (`getDb()`). Several existing
 * deferred-transaction sites are correct only because exactly one connection
 * exists in this process; a second one opened for MCP would break them
 * silently, under load, in a way no test would show.
 */
export interface Ctx {
  db: DB
  /** Which caller this is. A handler may refuse an MCP caller; none may refuse the UI. */
  source: 'ipc' | 'mcp'
  /**
   * The window that asked, or null. ALWAYS null over MCP — there is no window —
   * so an entry that needs a window is an entry that cannot be a tool.
   */
  sender: { id: number } | null
  /**
   * MCP-ONLY, request-scoped: which agent connection this call belongs to, and
   * what background material this response is about to hand it.
   *
   * Passed on `Ctx` rather than read from a module-level "current client"
   * because up to three tool bodies interleave across `await` points inside the
   * MCP queue, and a global would attribute one agent's payload to another. Null
   * for every renderer call, and null is the SAFE value: a `shape` that cannot
   * tell whether this client already has the dossier sends it.
   */
  dossier?: DossierRequestState | null
}

/**
 * What one MCP request has staged about the project background it is emitting.
 *
 * Payloads are recorded as SENT only after the response has actually been
 * serialized and handed to the transport whole (`commitRequest`, called from
 * `mcp/http.ts`), never at the moment `shape` builds them — "we built it" is not
 * "the agent received it", and treating them as the same is the one way this
 * feature could withhold background from an agent that never saw it.
 *
 * Declared here rather than in `mcp/` because `Ctx` may not import from there:
 * the registry is imported BY `mcp/server.ts`, and the reverse edge would close
 * a cycle over live function bindings.
 */
export interface DossierRequestState {
  /** Identifies the agent connection, or null when it cannot be identified. */
  key: string | null
  /** The bearer token this client presented, fingerprinted. */
  fingerprint: string
  /** Emitted this response; committed only if it is delivered intact. */
  pending: Array<{ slot: string; hash: string }>
  /** Set when the response was truncated or refused: nothing may be committed. */
  poisoned: boolean
}

export interface Entry<S extends z.ZodObject = z.ZodObject> {
  /** The IPC channel string. Must match `src/preload/index.ts` exactly. */
  channel: string
  /**
   * The MCP tool name, or null for "reachable from the UI only".
   *
   * `null` is the safe default and several channels are permanently null: any
   * channel that opens a native dialog (it would hang an agent on a human who is
   * not there) and any channel carrying a filesystem path.
   */
  tool: string | null
  access: Access
  /** Calls the model, or otherwise runs long. Counted against the quit drain. */
  slow?: boolean
  /**
   * Whether anything can actually back this tool right now, asked at LIST time.
   *
   * Absent means "always", which is what nearly every entry is: the capability
   * is compiled in, so its existence is not a question. The exception is an
   * entry whose work is done by a PLUGIN — `search_web` is answered by whatever
   * offers `paper-search` — where the honest answer changes with what the user
   * has installed and switched on.
   *
   * ABSENT FROM `tools/list`, not listed-and-failing. An agent plans against the
   * list it is given, so a tool that is present and always refuses is one it will
   * keep trying and keep building plans around; a tool that is not there is a
   * capability it correctly concludes this install does not have. This is the
   * same argument `access` filtering already makes, one level along.
   *
   * It does NOT gate dispatch. A stale list is unavoidable — the MCP transport
   * has no way to push a change (see `mcp/http.ts`) — so a call for a tool that
   * has since gone away must still be REFUSED WITH A SENTENCE by the entry's own
   * body, which is where the reason lives. A second gate here would answer it
   * with "unknown tool", which is a different and less true thing to say.
   */
  available?: () => boolean
  /**
   * What this does, in the words the AGENT reads at call time. Where a rule is
   * enforced but not expressible in JSON Schema — a `.refine()`, a fan-out, a
   * "this is not rolled back on disconnect" — it MUST be stated here, because
   * the agent will never see anything else.
   */
  summary: string
  /**
   * One hand-written line naming the DTO this returns, for the generated docs.
   *
   * The CHANNEL's return value — what the RENDERER receives. Where an entry also
   * declares a `shape`, the MCP client gets that instead, so a list entry saying
   * `XxxDTO[]` here while emitting `{items,total,limit,offset}` over MCP is
   * consistent rather than contradictory: `shape` is the authority on the tool's
   * payload, this line on the renderer's.
   */
  returns: string
  /** The single source of truth for this capability's arguments. */
  params: S
  /**
   * MCP-ONLY, and a strict SUBSET of `params`: same property names, same types,
   * value spaces only ever narrower. The sweep asserts the subset relation and
   * fails closed.
   *
   * It exists for exactly one shape of problem: `ingest:run` accepts a `kind` of
   * `'pdf'`/`'folder'` whose `value` is an absolute path, and the tool must
   * accept the other kinds and not those. One shared schema cannot say "the
   * channel takes six, the tool takes five".
   */
  toolParams?: z.ZodObject
  /**
   * The positional argument order, for channels the preload invokes positionally
   * (`invoke('works:analyses', workId, projectId)`). Absent means the channel
   * takes ONE object argument.
   *
   * Cross-checked against the preload forwarder's parameter NAMES by the sweep,
   * because a permuted order type-checks and silently swaps arguments.
   *
   * A CONSEQUENCE WORTH KNOWING BEFORE YOU HIT IT: for a positional channel the
   * schema's property names are not free — they must equal the preload
   * forwarder's parameter names, or the sweep reports a mismatch. When it does,
   * the fix is nearly always to rename the PRELOAD parameter (it is a local
   * name in a one-line forwarder) rather than the schema field, which is what
   * the docs, the tool description and the agent all see.
   */
  order?: readonly string[]
  /**
   * MCP-ONLY. Runs BEFORE `run`.
   *
   * Caps cannot live in the schema — the schema is shared with the UI, and the
   * UI legitimately asks for 3000 graph nodes. They cannot live in `shape`
   * either: by then the synchronous query has already blocked the main thread
   * for its whole duration. Clamping the ARGUMENTS is the only place a cap is
   * real.
   */
  clampArgs?: (args: z.infer<S>) => z.infer<S>
  run: (ctx: Ctx, args: z.infer<S>) => unknown | Promise<unknown>
  /**
   * MCP-ONLY. Reshapes the result for an agent: pairs a list with its true
   * `COUNT(*)`, redacts an absolute path down to a presence boolean, filters to
   * the paper that was asked for.
   *
   * Takes `ctx` and `args` because all three of those need them.
   */
  shape?: (result: unknown, ctx: Ctx, args: z.infer<S>) => unknown
}

/**
 * Define an entry, inferring `S` from `params` so `run`'s `args` is typed
 * without anyone writing the generic out.
 */
export function e<S extends z.ZodObject>(entry: Entry<S>): Entry<z.ZodObject> {
  return entry as unknown as Entry<z.ZodObject>
}
