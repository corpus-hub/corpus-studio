/**
 * The ONE vocabulary for `work.work_type`: what each value is CALLED and what it
 * is DRAWN as.
 *
 * The labels below cover exactly the DB CHECK constraint in `db/schema.ts` and
 * nothing else. A value outside it cannot reach the renderer, so an unknown one
 * is shown as it is stored rather than translated into a friendlier word that
 * would hide the fact that something wrote a type the schema forbids.
 */
const WORK_TYPE_LABELS: Record<string, string> = {
  'journal-article': 'Primary research',
  preprint: 'Preprint',
  'conference-paper': 'Conference paper',
  book: 'Book',
  'book-chapter': 'Book chapter',
  review: 'Review',
  method: 'Method',
  dataset: 'Dataset',
  thesis: 'Thesis',
  other: 'Other'
}

export const workTypeLabel = (t: string | null | undefined): string =>
  WORK_TYPE_LABELS[t ?? ''] ?? (t ?? 'work').replace(/[-_]/g, ' ')

/**
 * The ring palette shared by the Connectome and the Ranking frontier map.
 *
 * Four categories, because that is what a ring can actually distinguish at 12px
 * across a dense canvas — the ten schema types are collapsed into "Review",
 * "Method" and everything else ("Primary"), plus one MEASUREMENT, "Highly
 * cited", which is read off `citation_count` and never off the type.
 */
/**
 * FOUR HUES, NO GREY. Every category is a real thing a reader is meant to pick
 * out, and grey reads as "unset" — the two greys here also sat a shade apart,
 * so "Primary" and "Method" were nearly the same ring on a dense canvas. Each
 * is one of the palette's own tokens so a category cannot drift from the rest
 * of the app: `--accent` orange, `--busy` blue, `--ok` green, `--violet`.
 *
 * Primary takes the accent because it is the ordinary case and the one most
 * bubbles wear.
 */
export const RING_PRIMARY = '#e2600f'
export const RING_REVIEW = '#7a5aa8'
export const RING_HIGHLY_CITED = '#3f9166'
export const RING_METHOD = '#3f74a8'
/** A user VERDICT, not a type — always paired with a dashed stroke. */
export const RING_EXCLUDED = '#c1584a'

/**
 * How many works IN THIS CORPUS must cite a paper before it counts as a hub.
 * `citation_count` counts only edges the corpus itself carries, so this is a
 * statement about the reader's own collection, not about the field.
 */
export const HIGH_CITATION = 200

export type RingCategory = 'excluded' | 'review' | 'method' | 'highly-cited' | 'primary'

export const isReviewType = (t: string | null | undefined): boolean => /review/i.test(t ?? '')
export const isMethodType = (t: string | null | undefined): boolean => /method/i.test(t ?? '')

/**
 * Which ring a paper earns.
 *
 * `excluded` is FIRST because it is the reader's own decision and outranks
 * anything the metadata says; a type the paper actually HAS outranks a citation
 * count, so a highly cited review still reads as a review.
 */
export function ringCategory(
  workType: string | null | undefined,
  citationCount: number | null | undefined,
  excluded: boolean
): RingCategory {
  if (excluded) return 'excluded'
  if (isReviewType(workType)) return 'review'
  if (isMethodType(workType)) return 'method'
  if ((citationCount ?? 0) >= HIGH_CITATION) return 'highly-cited'
  return 'primary'
}

const RING_COLORS: Record<RingCategory, string> = {
  excluded: RING_EXCLUDED,
  review: RING_REVIEW,
  method: RING_METHOD,
  'highly-cited': RING_HIGHLY_CITED,
  primary: RING_PRIMARY
}

export const ringCategoryColor = (c: RingCategory): string => RING_COLORS[c]

/**
 * Excluded papers are dashed as well as red: exclusion is a different AXIS from
 * work type, and the two would otherwise share the one colour channel with no
 * way to tell "the user dropped this" from "this is some fifth kind of paper".
 */
export const ringDashArray = (c: RingCategory): string | undefined =>
  c === 'excluded' ? '3 2' : undefined

export const ringCategoryLabel = (c: RingCategory): string =>
  c === 'excluded'
    ? 'Excluded'
    : c === 'review'
      ? 'Review'
      : c === 'method'
        ? 'Method'
        : c === 'highly-cited'
          ? 'Highly cited'
          : 'Primary'

export const ringCategoryTip = (c: RingCategory): string | undefined =>
  c === 'highly-cited'
    ? `Cited by ${HIGH_CITATION} or more papers in this corpus.`
    : c === 'excluded'
      ? 'You excluded this paper from the project; it is still drawn so the shape of the corpus stays intact.'
      : undefined
