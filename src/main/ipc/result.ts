import type { DB } from '../db/connection'

/**
 * The shape every list-returning tool emits, and the budget that stops any tool
 * returning a corpus.
 *
 * IN `ipc/` AND NOT `mcp/`, even though only the MCP layer uses it: registry
 * entries call `listScope`, and `mcp/server.ts` imports the registry, so a
 * `registry -> mcp` edge would close a cycle. Cycles between modules that only
 * exchange types are harmless; this one exchanges functions, and one of those
 * bindings would be undefined at module-init time depending on which side was
 * loaded first.
 */

/**
 * 4 MiB of serialized JSON, per response.
 *
 * `export:project` returns an entire project as one string and `graph:get`'s
 * UI-shared `limit` has no ceiling of its own, so without this one call puts
 * tens of megabytes into an agent's context — which it then pays for on every
 * subsequent turn of the conversation.
 */
export const RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024

export interface ListScope {
  items: unknown[]
  total: number
  limit: number | null
  offset: number
  /**
   * WHY the result is what it is, when it is empty.
   *
   * A bare `[]` reads to an agent as "I looked and there is nothing", when the
   * truth is very often "this install has no papers yet" — and it will then
   * confidently report an absence of evidence. Computed from real counts, never
   * guessed.
   */
  scope_note: string | null
}

export function listScope(
  items: unknown[],
  total: number,
  opts: { note: string | null; counts: string | null; limit?: number | null; offset?: number }
): ListScope {
  return {
    items,
    total,
    limit: opts.limit ?? null,
    offset: opts.offset ?? 0,
    scope_note: opts.note ?? opts.counts ?? null
  }
}

/**
 * The sentences an empty result explains itself with.
 *
 * Each reads the DB for the real number rather than asserting a plausible one:
 * "14 papers in this project; none match these filters" is actionable, and
 * "there may be no papers" is not.
 */
export const scopeNote = {
  installCounts(db: DB): string | null {
    try {
      const row = db
        .prepare('SELECT (SELECT COUNT(*) FROM project) AS projects, (SELECT COUNT(*) FROM work) AS works')
        .get() as { projects: number; works: number }
      if (row.projects === 0) {
        return 'This install has no projects yet. Papers are imported in the app itself, not through any tool here — ask the user to add some.'
      }
      if (row.works === 0) {
        return `This install has ${row.projects} project(s) and no papers yet.`
      }
      return null
    } catch {
      return null
    }
  },

  emptyProject(db: DB, projectId: number): string | null {
    try {
      const exists = db.prepare('SELECT 1 FROM project WHERE id = ?').get(projectId)
      if (!exists) return `No project has id ${projectId}. Call projects_list for the ids that exist.`
      return `Project ${projectId} holds no papers yet.`
    } catch {
      return null
    }
  },

  filteredOut(total: number, projectId: number): string {
    return `${total} paper(s) in project ${projectId}; none match these filters.`
  }
}

export interface Budgeted {
  json: string
  truncated: boolean
}

/**
 * Serialize within the budget, truncating a list at a ROW boundary if it
 * overflows.
 *
 * Row boundary rather than byte: a JSON document cut mid-string is not a partial
 * answer, it is an unparseable one, and an agent handed that has no way to
 * recover except to retry the identical call.
 */
export function serializeWithinBudget(value: unknown): Budgeted {
  const json = safeStringify(value)
  if (json.length <= RESPONSE_BUDGET_BYTES) return { json, truncated: false }

  const scope = value as Partial<ListScope>
  if (!Array.isArray(scope?.items)) {
    // Not a list. There is no row boundary to cut on, so refuse rather than
    // hand back a broken document.
    return {
      json: safeStringify({
        truncated: true,
        error: 'the result exceeds the 4 MiB response budget and cannot be split',
        hint: 'ask for a narrower slice of this data'
      }),
      truncated: true
    }
  }

  // Halve until it fits. Linear scanning would serialize the list once per row.
  let keep = scope.items.length
  let out = json
  while (keep > 0 && out.length > RESPONSE_BUDGET_BYTES) {
    keep = Math.floor(keep / 2)
    out = safeStringify({
      ...scope,
      items: scope.items.slice(0, keep),
      truncated: true,
      returned: keep,
      total: scope.total ?? scope.items.length,
      hint: 'narrow with limit/offset or filters'
    })
  }
  return { json: out, truncated: true }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null'
  } catch {
    return JSON.stringify({ error: 'the result could not be serialized' })
  }
}
