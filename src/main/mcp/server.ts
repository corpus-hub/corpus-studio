import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js'
import { getDb } from '../db/connection'
import { ENTRIES, inputSchemaOf, mcpTools, toolEntry, type PermissionLevel } from '../ipc/registry'
import type { Ctx, DossierRequestState, Entry } from '../ipc/types'
import { admit, McpBusyError } from './queue'
import { trackBusy } from '../busy'
import { serializeWithinBudget } from '../ipc/result'
import { audit } from './audit'
import { redactKnownSecrets, redactSecrets } from './auth'
import { scrubPaths, scrubValue } from './redact'
import { noteCall } from './status'
import { health } from './health'

/**
 * The MCP protocol server: what an agent is shown, and what happens when it
 * calls something.
 *
 * The tool list is a FILTER OF `ENTRIES`, never a parallel set of definitions.
 * That is the whole reason the registry exists: 70 hand-written tool schemas
 * beside 70 zod schemas drift the first time a filter is added to one of them,
 * and the drift is invisible until an agent sends an argument the channel
 * silently ignores.
 *
 * The low-level `Server` rather than the `McpServer` sugar: the sugar wants a
 * zod shape per tool so it can validate for us, and we already have the JSON
 * Schema and the validation — routing through it would mean converting our
 * schema into its expected form and back.
 */

const HEALTH_TOOL = 'health'

let startedAt = Date.now()

export function markServerStart(): void {
  startedAt = Date.now()
}

export interface ServerDeps {
  level: () => PermissionLevel
  /** True once a quit is genuinely under way. Writes are refused past that point. */
  quitting: () => boolean
  remoteAddress: string
  /**
   * Request-scoped state for the project-background re-send suppression, or
   * absent. Absent is SAFE: a `shape` with no state to consult sends the full
   * background rather than a marker.
   */
  dossier?: DossierRequestState | null
}

/**
 * What lands in the agent's system prompt at `initialize`.
 *
 * The single highest-leverage piece of documentation in the feature: an agent
 * never reads a file in this repo, and it always reads this. Everything here is
 * a rule that, got wrong, produces a confident wrong answer rather than an
 * error.
 */
const INSTRUCTIONS = `Corpus Studio is a local scientific-literature workbench. You are talking to one
person's own corpus on their own machine.

CONVENTIONS
- Tool inputs are camelCase; outputs are snake_case (they are the database's own
  names). Do not rename them between tools — one tool's output feeds another's input.
- List results are { items, total, limit, offset, scope_note }. \`total\` is a real
  COUNT(*), not items.length. When a result is empty, READ \`scope_note\`: it says
  whether the install is empty, the project is empty, or your filters excluded
  everything. Reporting "no evidence found" from an empty install is a serious error.

RESOLVING A PAPER
- Paper tools take a numeric \`workId\`. If you have a DOI, an arXiv id, a URL or a
  title, call \`paper_resolve\` first and pass the \`work_id\` it returns.
- A title matching two papers returns \`ambiguous\` and you must choose. It will not guess.

TWO RANKINGS, NEVER FUSED
- \`relevance\` and \`expansion_priority\` measure different things. Never average or
  combine them.

STATES ARE NOT ERRORS
- \`no-source\`, \`no-dossier\`, \`no-text\` describe what the app knows about a paper.
  They are answers, not failures.

WRITES
- A write is NOT rolled back if your call times out or your connection drops. Read
  the state back before retrying anything that mutates.

PROJECTS
- A paper is stored once; its interpretation (relevance, inclusion, notes) is
  per-project. Never pool those numbers across projects.

PROJECT BACKGROUND — \`project_context\`
- A project can hold BACKGROUND CLAIMS drawn from the papers its owner marked as
  reference papers. When a read carries a \`project_context\`, that background is
  part of the answer: it is what the rest of this collection already establishes,
  and the app's own analyses were produced with it. Read it before you answer.
- It is BACKGROUND. Never let it override a value the paper you are reading
  reports itself, and never quote it as something this paper says.
- \`project_context.entries\` present => the material is right there.
- \`project_context: { dossier_hash, already_sent: true }\` means it was sent to
  you earlier in this session under that hash. LOOK FOR IT: find an earlier
  \`project_context\` in this conversation whose \`dossier_hash\` equals the one
  you were just given. If you cannot see one with that exact hash — new
  conversation, compacted history, a summary you inherited, anything — you do NOT
  have it, and you MUST call \`dossier_context_get\` with that paper's workId and
  the projectId before answering. That call is free, read-only and always safe.
  Answering from a hash you cannot resolve is guessing.
- No \`project_context\` at all means this project has no background to give.
  That is the ordinary case and is not an error.`

export function buildServer(deps: ServerDeps): Server {
  const server = new Server(
    { name: 'corpus-studio', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  )

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const level = deps.level()
    return {
      tools: [
        {
          name: HEALTH_TOOL,
          description:
            'Is this connected to the corpus you think it is? Returns install counts, the ' +
            'schema version and uptime. A fresh install is legitimately empty — check here ' +
            'before concluding that a search found nothing.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        ...mcpTools(level).map((entry) => ({
          name: entry.tool as string,
          description: entry.summary,
          inputSchema: inputSchemaOf(entry)
        }))
      ]
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const level = deps.level()
    const name = request.params.name
    const rawArgs = request.params.arguments ?? {}
    const began = Date.now()

    if (name === HEALTH_TOOL) {
      noteCall(name)
      const result = health(startedAt, mcpTools(level).length + 1, level)
      audit({ tool: name, access: 'read', address: deps.remoteAddress, outcome: 'ok', ms: Date.now() - began })
      return textResult(result)
    }

    // Re-checked HERE and not only at list time: lowering the permission level
    // mid-session must take effect on the next call, not on the next time the
    // agent happens to re-list.
    const entry = toolEntry(name, level)
    if (!entry) {
      const exists = ENTRIES.some((e) => e.tool === name)
      audit({
        tool: name,
        access: 'unknown',
        address: deps.remoteAddress,
        outcome: 'refused',
        ms: Date.now() - began,
        reason: exists ? 'above-permission-level' : 'no-such-tool'
      })
      throw new McpError(
        ErrorCode.MethodNotFound,
        exists
          ? `The tool "${name}" needs a higher permission level than this server is set to. ` +
              `The person who owns this install raises it in Settings \u2192 MCP.`
          : `There is no tool called "${name}".`
      )
    }

    const mutating = entry.access !== 'read'

    // Once a quit is genuinely under way, stop accepting anything that writes.
    // Otherwise an agent still issuing writes holds the "finishing" phase open
    // and the app simply never closes. Reads keep working until the connection
    // goes away with the process.
    if (mutating && deps.quitting()) {
      audit({
        tool: name,
        access: entry.access,
        address: deps.remoteAddress,
        outcome: 'refused',
        ms: Date.now() - began,
        reason: 'shutting-down'
      })
      return errorResult('The app is shutting down and is not accepting changes. Nothing was written.')
    }

    noteCall(name)

    try {
      const parsed = (entry.toolParams ?? entry.params).parse(rawArgs)
      const args = entry.clampArgs ? entry.clampArgs(parsed) : parsed

      const value = await admit({ slow: entry.slow === true, mutating }, async () => {
        const body = async (): Promise<unknown> => {
          const ctx: Ctx = {
            db: getDb(),
            source: 'mcp',
            sender: null,
            dossier: deps.dossier ?? null
          }
          const raw = await entry.run(ctx, args)
          return entry.shape ? entry.shape(raw, ctx, args) : raw
        }
        // WRITES ONLY. They are counted as app busyness so the close guard
        // prompts before `will-quit` is ever reached, and the user is asked
        // rather than having a half-written supersede-then-insert cut off under
        // them.
        //
        // Reads are not counted even when `slow`, and that is the whole of the
        // rule: a polling agent would otherwise hold the quit prompt open — the
        // exact hostage-taking the guard already refuses to allow for semantic
        // search. And `admit` deliberately RETURNS on timeout while the body
        // keeps running, so a hung ten-minute read would leave the counter up
        // with nothing left to bring it down.
        return mutating ? trackBusy(body) : body()
      })

      audit({
        tool: name,
        access: entry.access,
        address: deps.remoteAddress,
        outcome: 'ok',
        ms: Date.now() - began,
        // Arguments are recorded for writes only. A read's arguments are a search
        // term, and logging every one of those unconditionally would build a
        // record of what the user's agent was curious about for no safety gain.
        args: mutating ? args : undefined
      })
      return textResult(value, deps.dossier)
    } catch (err) {
      // Whatever background this call staged did NOT reach the agent: the result
      // it was attached to is being replaced by an error message. Marking it
      // delivered would suppress it from the retry.
      if (deps.dossier) deps.dossier.poisoned = true
      audit({
        tool: name,
        access: entry.access,
        address: deps.remoteAddress,
        outcome: 'error',
        ms: Date.now() - began,
        args: mutating ? rawArgs : undefined,
        error: outbound(err)
      })
      if (err instanceof McpBusyError) {
        throw new McpError(
          ErrorCode.InternalError,
          `The app is busy with other agent calls. Retry in about ${Math.round(err.retryAfterMs / 1000)}s.`
        )
      }
      // An ordinary failure — an invalid argument, a missing row — is returned
      // as an `isError` RESULT, not thrown as a protocol error: it is something
      // the agent can read and act on, and a protocol error tells it only that
      // the transport is unhappy.
      return errorResult(outbound(err))
    }
  })

  return server
}

/**
 * Everything that leaves this process towards the agent, cleaned.
 *
 * A better-sqlite3 or fs failure carries an absolute path, which is
 * `/home/<username>/...` — the same disclosure `health.ts` deliberately avoids
 * by returning only a basename. Volunteering it in an error message would make
 * that care pointless.
 */
function outbound(err: unknown): string {
  return scrubPaths(redactSecrets(String((err as Error)?.message ?? err)))
}

/**
 * A successful result, on its way to the agent.
 *
 * Path scrubbing applies to SUCCESSES and not only to errors. Every DTO that
 * ever carries a filesystem path — an outlet's vault, a base directory, a
 * document's location, a stage's stored error text — would otherwise disclose
 * `/home/<username>/…` through the one code path nobody thinks to check, because
 * the per-entry `shape` redaction is a thing an author has to remember. This is
 * the floor under that.
 *
 * `scrubValue` runs BEFORE serialization and `redactKnownSecrets` after. The
 * order is not arbitrary: path scrubbing has to see each string separately, or a
 * path containing a quote breaks the JSON around it and a path after a `\n`
 * escape is not recognised at all. Secret redaction is an exact-match substring
 * pass, which is safe on the encoded form and catches a secret wherever it
 * landed.
 *
 * `redactKnownSecrets` and NOT `redactSecrets`: the shape-based pass matches any
 * 32-character run of the base64url class, which is every 64-hex provenance
 * digest we return (`doc_input_hash`, `prompt_input_hash`, `recorded_hash`…).
 * Those fields are the only thing that identifies WHICH input a disagreement is
 * about, so redacting them turns a usable answer into an unusable one, silently
 * and with no truncation flag. Exact matches against the secrets we hold cannot
 * have that problem.
 */
function textResult(
  value: unknown,
  dossier?: DossierRequestState | null
): { content: Array<{ type: 'text'; text: string }> } {
  const { json, truncated } = serializeWithinBudget(scrubValue(value))
  // A truncated result may have had the project background cut out of it — the
  // over-budget branch replaces the whole document with a refusal envelope, and
  // even the row-halving branch is a document the agent is told not to trust as
  // complete. Either way it must not count as delivered.
  if (truncated && dossier) dossier.poisoned = true
  return { content: [{ type: 'text', text: redactKnownSecrets(json) }] }
}

function errorResult(message: string): {
  isError: true
  content: Array<{ type: 'text'; text: string }>
} {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** How many tools this level exposes, `health` included. For the status DTO. */
export function toolCountFor(level: PermissionLevel): number {
  return mcpTools(level).length + 1
}

export type { Entry }
