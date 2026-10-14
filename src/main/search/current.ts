import { VectorSearch } from './vectorSearch'

/**
 * The vector-search worker handle, reachable WITHOUT importing `index.ts`.
 *
 * Same reasoning as `llm/current.ts`: `search:semantic` is an IPC registry
 * entry, and the registry may not import `electron` or `index.ts` — the second
 * would be a cycle, and the first is the property that makes the registry
 * loadable (and therefore checkable) outside an Electron main process.
 *
 * Constructed on first use, and the worker THREAD it owns is spawned lazily on
 * the first query after that — the thread loads a second ONNX session, and a
 * session that never searches should not pay for it.
 *
 * RECONSTRUCTIBLE rather than a startup singleton, because `before-quit` fires
 * on a quit the close guard may then CANCEL. A handle dropped on that path and
 * only ever reassigned at startup would leave semantic search dead — with a bare
 * "not initialised" error — for the rest of a session the user chose to keep.
 * Rebuilding costs one object; the worker itself is still lazy.
 */
let vectorSearch: VectorSearch | null = null
let vectorDbPath: string | null = null

/** Record where the index lives. Called once, from startup. */
export function setVectorDbPath(path: string): void {
  vectorDbPath = path
}

export function getVectorSearch(): VectorSearch {
  if (vectorSearch) return vectorSearch
  if (!vectorDbPath) throw new Error('vector search is not initialised')
  vectorSearch = new VectorSearch(vectorDbPath)
  return vectorSearch
}

/**
 * Drop the handle and shut its worker down, fire-and-forget.
 *
 * The worker holds a READ-ONLY connection on the same file, so it can be dropped
 * at any moment without risking the database — and waiting on it could only
 * delay a quit, never protect data.
 */
export function dropVectorSearch(): void {
  const vs = vectorSearch
  vectorSearch = null
  void vs?.shutdown()
}
