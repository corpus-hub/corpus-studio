// The search-source plugin contract.
//
// Corpus Studio owns the SHAPE of a search result; a source owns only how to
// obtain raw hits from its upstream and how to bend them into that shape. This
// direction matters: upstreams disagree wildly about their fields (CrossRef has
// DOIs and citation counts but no abstract, PubMed has neither DOI nor
// abstract, arXiv has an abstract and no DOI), so if the studio consumed each
// upstream's native shape the disagreement would leak into the UI.
//
// Everything downstream of a source — scoring, filtering, sorting, dedup, the
// result cap — is applied CENTRALLY by the registry, so a newly added source
// inherits identical semantics without reimplementing them.

import type { WebSearchRecord, WebSearchOptions } from '../adapters'

export type { WebSearchRecord, WebSearchOptions }

/** Why a source produced nothing, so the UI can distinguish "no hits" from "broken". */
export interface SourceFailure {
  sourceId: string
  message: string
}

/**
 * One pluggable origin of papers that are NOT yet in the corpus.
 *
 * `search` returns raw candidates. It should NOT filter, sort, dedup or cap —
 * the registry does all of that. It SHOULD normalize into `WebSearchRecord`,
 * because only the source knows what its upstream's fields mean.
 */
export interface SearchSource {
  /** Stable key used to enable/disable and to attribute failures. */
  readonly id: string
  /** Human-readable name, for diagnostics. */
  readonly label: string
  /**
   * Fetch candidates for a query.
   *
   * `limit` is a HINT for how many to fetch upstream, not a guarantee the
   * registry will keep that many: after merging across sources the registry
   * re-ranks and caps globally.
   *
   * The signal is honoured so a superseded search stops costing the upstream
   * (and the user's rate limit) the moment the query changes.
   */
  search(query: string, opts: SourceSearchOptions): Promise<WebSearchRecord[]>
}

export interface SourceSearchOptions {
  limit: number
  /**
   * 1-based page to fetch from the upstream.
   *
   * Paging is pushed DOWN to the source rather than done by slicing a merged
   * list, because the indexes hold orders of magnitude more than one request
   * can carry — "show more" has to actually ask them for more.
   */
  page: number
  signal?: AbortSignal
  /**
   * Filters the SOURCE should push to its upstream.
   *
   * These are a duplicate of fields the registry also applies locally, and deliberately so.
   * The registry's pass is the guarantee -- it runs for every source, including ones whose
   * upstream cannot express a filter at all. Pushing them down as well is an OPTIMISATION
   * with a large effect: filtering a fetched page of 25 by year discards most of it, while
   * asking the index for the right years returns 25 useful rows.
   *
   * A source that ignores these stays CORRECT, just wasteful, which is the property that
   * makes the duplication safe.
   */
  yearFrom?: number
  yearTo?: number
  author?: string
}
