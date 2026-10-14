// Recovering a bibliography POSITION from Crossref's `key` field, or refusing to.
//
// This is the load-bearing piece of the whole module and it is almost entirely
// refusal, because an ordinal is what joins an index-supplied reference to the
// in-text callouts the app already scanned. Get it right and a Crossref
// reference inherits every `[7]` in the paper; get it off by four and the app
// attaches real sentences to the wrong paper with full confidence — which is
// worse than having no ordinal at all, and invisible to the user.
//
// `key` is OPAQUE by specification. Crossref requires only that it be unique
// within the deposit; publishers use it for whatever their production system
// happens to number. Measured across the KE07 corpus:
//
//   Springer   BFnature06879_CR1 … _CR34        1..34, dense    -> usable
//   Nature     ...s41467-018-06305-y_CR1 … _CR67 1..67, dense   -> usable
//   Elsevier   bb0025, bb0050 … bb1150           5..230, step 5 -> REFUSED
//   Wiley      e_1_2_1_2_1                       0 numbers      -> REFUSED
//   ACS        ja804040s-cit1 (partial)          23 of 42       -> REFUSED
//   RSC        c6cp03622h-cit... no trailing num 0 of 53        -> REFUSED
//   PNAS/Sci   1..n but as bare `key` values     dense          -> usable
//
// Elsevier is the case that motivates the strictness: `bb0025` yields 25, the
// keys are unique, ascending, and every one parses. Every check short of "the
// set is exactly 1..n" passes it, and it is wrong by a factor of five.

/** The trailing integer of a Crossref `key`, or null. */
function trailingNumber(key: string): number | null {
  const m = /(\d+)\s*$/.exec(key.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Assign each key its bibliography position, or return null for ALL of them.
 *
 * All-or-nothing by design. A partial mapping is the worst outcome available:
 * the entries that got a number would link to callouts and the ones that did
 * not would not, so the paper would show a citation graph that is confidently
 * right in some places and silently missing in others, with nothing marking
 * which is which. ACS's 23-of-42 is exactly that shape.
 *
 * The three conditions, each of which has a counter-example above:
 *   1. EVERY key yields a number (rules out Wiley, RSC, ACS).
 *   2. They are DISTINCT (a repeated number means the field means something
 *      else entirely).
 *   3. The set is exactly {1..n} (rules out Elsevier's stride-5 and its
 *      out-of-range maximum).
 *
 * Condition 3 subsumes 2, and both are kept: `new Set` is what makes the
 * subsumption true, and stating it separately is what makes the intent legible
 * to the next reader deciding whether to relax one of them.
 */
export function recoverOrdinals(keys: Array<string | null | undefined>): Array<number | null> {
  const none = keys.map(() => null)
  if (keys.length === 0) return none

  const nums: number[] = []
  for (const k of keys) {
    if (!k) return none
    const n = trailingNumber(k)
    if (n === null) return none
    nums.push(n)
  }

  const distinct = new Set(nums)
  if (distinct.size !== nums.length) return none
  for (let i = 1; i <= nums.length; i += 1) {
    if (!distinct.has(i)) return none
  }
  return nums
}

/**
 * The fallback: the ARRAY ORDER Crossref returned, when the keys are unusable.
 *
 * NOT used, and this function exists to be pointed at rather than called. It is
 * written down because "just number them in the order they came back" is the
 * obvious next idea and it is wrong: Crossref's `reference` array is not
 * documented to preserve deposit order, and for the RSC and Wiley papers above
 * it demonstrably does not match the printed list — those publishers deposit
 * references in XML-tree order, which for a paper with grouped or nested
 * citations is not reading order.
 *
 * If a future reader wants positional linking for those publishers, the sound
 * route is to match the index's reference to a PRINTED entry (which has a real
 * ordinal, measured from the page) and take the ordinal from there. That is
 * what `reconcile.ts` does, and it is why it does it by DOI rather than by
 * position.
 */
export function positionalOrdinalsAreNotSound(): never {
  throw new Error('array position is not a bibliography ordinal — see reconcile.ts')
}
