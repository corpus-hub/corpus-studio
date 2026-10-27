import { REVIEW_REASON_ORDER, type ReviewItemDTO, type ReviewReasonKey } from '@shared/contract'

/**
 * Narrowing and ordering the review queue by WHY each item is in it.
 *
 * The reasons themselves are computed in main, beside the membership predicate;
 * nothing here re-derives one. This module only decides what a chosen set of
 * categories means for a list of items, which is the part worth testing on its
 * own.
 */

/** Rank of a single reason — lower is more serious. */
export function reasonRank(reason: ReviewReasonKey): number {
  const i = REVIEW_REASON_ORDER.indexOf(reason)
  return i === -1 ? REVIEW_REASON_ORDER.length : i
}

/**
 * An item's seriousness is its MOST serious reason.
 *
 * A fact can satisfy several clauses at once — a contradicted check on an
 * inferred value is both — and reading it by its mildest reason would bury a
 * verdict at the bottom of the list among cautions.
 */
export function itemSeverity(item: Pick<ReviewItemDTO, 'reasons'>): number {
  let best = REVIEW_REASON_ORDER.length
  for (const r of item.reasons) best = Math.min(best, reasonRank(r))
  return best
}

/**
 * Most serious first, ties broken by fact id.
 *
 * The tiebreak is what makes the order deterministic: two items of equal
 * seriousness must not swap places between two renders of the same data.
 */
export function sortBySeverity<T extends Pick<ReviewItemDTO, 'reasons' | 'fact_id'>>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) => itemSeverity(a) - itemSeverity(b) || a.fact_id - b.fact_id)
}

/**
 * How many items each category holds — over the WHOLE queue, never the filtered
 * view, so the numbers do not move as the user ticks boxes and a category they
 * turned off still says what turning it back on would bring.
 *
 * An item counts under EVERY reason it satisfies, so the counts sum to more than
 * the queue when items are multi-reason. That is the honest reading of "how many
 * would this category show me".
 */
export function reasonCounts(
  items: readonly Pick<ReviewItemDTO, 'reasons'>[]
): Record<ReviewReasonKey, number> {
  const out = Object.fromEntries(REVIEW_REASON_ORDER.map((r) => [r, 0])) as Record<
    ReviewReasonKey,
    number
  >
  for (const it of items) for (const r of new Set(it.reasons)) out[r] += 1
  return out
}

/**
 * Keep an item when ANY of its reasons is still selected.
 *
 * An empty set means "no restriction stated", matching `MultiSelect`'s own
 * semantics — untouched and emptied both show everything, because a filter
 * nobody has narrowed must not hide anything. ALL-of would make a multi-reason
 * fact vanish the moment one of its reasons was deselected, which is exactly the
 * silent loss this filter exists to prevent.
 */
export function filterByReasons<T extends Pick<ReviewItemDTO, 'reasons'>>(
  items: readonly T[],
  picked: ReadonlySet<string>
): T[] {
  if (picked.size === 0) return [...items]
  return items.filter((it) => it.reasons.some((r) => picked.has(r)))
}
