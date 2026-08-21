/**
 * MCP-side argument caps.
 *
 * better-sqlite3 is synchronous on the main thread, so every read an agent makes
 * freezes the UI for its whole duration. A cap cannot live in the entry's schema
 * — the schema is shared with the renderer, and the graph screen legitimately
 * asks for 3000 nodes — and it cannot live in `shape`, because by then the query
 * has already run. Clamping the ARGUMENTS is the only place a cap is real.
 *
 * These are deliberately generous enough that an agent doing ordinary work never
 * meets them, and tight enough that a looping one cannot stall the window.
 */

export const CLAMP = {
  /** Rows per list call. */
  limit: 200,
  /** Semantic-search neighbours. Each one is an ONNX forward pass. */
  k: 50,
  /** Graph nodes. The UI's own ceiling is far higher; an agent reading JSON needs less. */
  graphNodes: 300,
  /** Reference-tree depth. Each level multiplies the node count. */
  depth: 3,
  /** Characters of document text per call. */
  textChars: 20_000,
  /** Unresolved references listed per citing work in a reference tree. */
  unresolvedPerWork: 5
} as const

/** Clamp to `[1, max]`, treating a missing value as `max`. */
export function cap(value: number | null | undefined, max: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return max
  return Math.max(1, Math.min(Math.trunc(value), max))
}

/** Clamp an offset to a non-negative integer. */
export function capOffset(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}
