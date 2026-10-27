// Reciprocal Rank Fusion over the ranked chunk-id lists the search legs
// produce.
//
// RRF needs no score normalisation, which is the whole reason it is the fuse
// here: a bm25() score (unbounded, smaller-is-better) and a cosine (bounded,
// bigger-is-better) cannot be averaged, but their RANKS can be combined. A
// chunk's score is the sum over the legs it appears in of 1/(k + rank), rank
// starting at 1 — an order-only quantity, so fusion can never mistake a
// distance for a probability, and k smooths how steeply the head of a list
// dominates the answer.

/** The smoothing constant. The literature's value; insensitive across 20-100. */
export const RRF_K = 60

/**
 * Fuse ranked chunk-id lists (best first) into one score map.
 *
 * A chunk absent from a list contributes nothing for that leg, so the lists
 * may be any length and either may be empty — fusing one list is that list's
 * order, which is exactly the honest degradation when the other leg did not
 * run. Deterministic: identical lists always produce identical scores.
 */
export function rrfFuse(lists: number[][]): Map<number, number> {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach((chunkId, i) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (RRF_K + i + 1))
    })
  }
  return scores
}
