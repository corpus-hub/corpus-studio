import { z } from 'zod/v4'
import { e, type Entry } from '../types'
import {
  search as searchRepo,
  countSearch,
  getFacets,
  listSearchHistory,
  recordSearch,
  findPapersInProject,
  SEARCH_LIMIT
} from '../../db/repositories'
import { runSemanticSearch, semanticCoverage, DEFAULT_K } from '../../search/semantic'
import { getVectorSearch } from '../../search/current'
import { createSearchRegistry } from '../../search'
import type { SearchSourceRegistry } from '../../search/registry'
import { enabledPluginsWithCapability } from '../../plugins/host'
import { CLAMP, cap, capOffset } from '../clamp'
import { listScope, scopeNote } from '../result'

/**
 * Search — BY WORD and BY MEANING, with the whole capability surface the search
 * screen offers.
 *
 * The two modes are two tools and not a `mode` argument, deliberately: the
 * facets, the ranges, the sorts and the saved-search history apply to the
 * keyword search ONLY, and the screen swaps its entire filter rail for exactly
 * that reason. A single tool with silently-ignored filters would lie to the
 * agent about what its call did.
 *
 * ORDER IS THE FOOTGUN HERE. `search:query(query, projectId, filters)` and
 * `search:facets(projectId, query, filters)` sit fourteen lines apart in the
 * preload with the same property names in a DIFFERENT order; a permuted `order`
 * type-checks and silently swaps arguments. Both are transcribed from the
 * preload forwarders and the sweep re-checks them against it.
 *
 * `.nullish()` and not `.optional()` on every optional positional slot: the
 * registry loop turns a missing positional argument into a present `undefined`
 * and a positional `null` into a present `null`, and `.optional()` REJECTS the
 * second. The v3 handlers coped by writing `parse(x ?? undefined)` at every
 * call site; the schema carries it now, and each `run` normalises `null` back to
 * `undefined` before it reaches a repository whose defaults are written for it.
 */

const projectId = z.number().int().nonnegative()

/** Re-authored from the v3 `querySchema` at `index.ts:1219`. */
const querySchema = z.string().max(500)

/**
 * Re-authored from the v3 `searchFiltersSchema`.
 *
 * `.strict()` is load-bearing and preserved: an unknown facet key is REJECTED
 * rather than ignored, so a renderer (or an agent) that invents a filter is told
 * so instead of quietly getting an unfiltered corpus back.
 *
 * The year regex accepts a bare year ("1998") or a decade label as produced by
 * `decadeLabel()` — whose separator is an EN DASH and is load-bearing. The
 * character class covers hyphen, en dash and em dash because all three reach it
 * from real input.
 */
const facetValues = z.array(z.string().min(1).max(200)).max(200)
const searchFiltersSchema = z
  .object({
    work_type: facetValues.optional(),
    venue: facetValues.optional(),
    year: z
      .array(z.string().regex(/^\s*\d{1,4}(\s*[-–—]\s*\d{1,4})?\s*$/))
      .max(200)
      .optional(),
    inclusion_status: facetValues.optional(),
    content_status: facetValues.optional(),
    yearFrom: z.number().int().min(1000).max(3000).optional(),
    yearTo: z.number().int().min(1000).max(3000).optional(),
    minCitations: z.number().int().min(0).optional(),
    author: z.string().max(200).optional(),
    sort: z.enum(['relevance', 'year', 'citations', 'title']).optional()
  })
  .strict()
  .nullish()

/**
 * How the corpus search is described to an agent. Long, and every sentence of it
 * is a rule the agent cannot see anywhere else: the JSON Schema shows the field
 * names and nothing about what they MEAN.
 */
const SEARCH_SEMANTICS =
  'Query syntax: "|" separates ALTERNATIVES ("kcat | turnover" matches either); an empty ' +
  'query means every paper. Matching is a folded (case- and accent-insensitive) substring ' +
  'over title, abstract and venue — it is NOT stemmed, so "binding" does not match "bind". ' +
  'Facet arrays are OR-ed within a facet and AND-ed across facets. year takes an exact year ' +
  '("1998") or a decade label ("1990–1999", EN DASH). yearFrom/yearTo/minCitations are ' +
  'bounds and apply alongside the facets; a paper with no year never satisfies a year bound. ' +
  'author is a folded substring and a COMMA-SEPARATED list means ANY of them. ' +
  'OMIT projectId for an unscoped search — do NOT pass 0, which is the global-analysis ' +
  'sentinel and is not a project, so it matches nothing. Unscoped, inclusion_status also ' +
  'matches NOTHING (it is a project-specific interpretation of a paper, and the same paper ' +
  'carries a different status in another project) and sort "relevance" silently degrades to ' +
  'TITLE order, because relevance IS the project\u2019s stored ranking.'

/**
 * The web-search source registry, built on first use.
 *
 * Lazy and not module-scope: `verify-registry.ts` imports ENTRIES outside a
 * running app, and construction at import time would run this file\u2019s side
 * effects there. The v3 original built it once per `registerIpc()`; once per
 * process is the same object with a later birthday.
 */
let retrieval: SearchSourceRegistry | null = null
const getRetrieval = (): SearchSourceRegistry => (retrieval ??= createSearchRegistry())

const nowIso = (): string => new Date().toISOString()

/** Facet buckets an agent is shown per dimension. A corpus can hold thousands of venues. */
const FACET_BUCKETS = 50

export const SEARCH_ENTRIES: Entry[] = [
  e({
    channel: 'search:query',
    tool: 'papers_search',
    access: 'read',
    summary:
      'Search the papers already in this corpus BY WORD, with every filter and sort the app\u2019s ' +
      'own search screen offers. ' +
      SEARCH_SEMANTICS +
      ` At most ${SEARCH_LIMIT} rows are matched by the database; limit and offset page over ` +
      `THOSE, and limit defaults to ${CLAMP.limit} when omitted. "total" is the TRUE match ` +
      'count from a separate uncapped count, so total can exceed what any paging can reach — ' +
      'an offset past the matched rows returns an empty page and says so in scope_note, and ' +
      'the remedy is always to narrow with filters, never to page further. ' +
      'For meaning-based search use papers_search_by_meaning.',
    returns: 'SearchResultDTO[]',
    params: z.object({
      query: querySchema,
      projectId: projectId.nullish(),
      filters: searchFiltersSchema,
      // MCP-only paging over the repository's capped result set. The UI passes
      // three positional arguments and never these, so the channel is unchanged.
      limit: z.number().int().min(1).max(SEARCH_LIMIT).nullish(),
      offset: z.number().int().nonnegative().nullish()
    }),
    order: ['query', 'projectId', 'filters'],
    clampArgs: (a) => ({
      ...a,
      limit: cap(a.limit, CLAMP.limit),
      offset: capOffset(a.offset)
    }),
    run: (ctx, a) => searchRepo(ctx.db, a.query, a.projectId ?? undefined, a.filters ?? undefined),
    shape: (result, ctx, a) => {
      const rows = result as unknown[]
      const offset = a.offset ?? 0
      const limit = a.limit ?? rows.length
      // The TRUE total, from the uncapped count — never `rows.length`. The
      // repository comment beside `countSearch` exists because conflating the
      // two is the bug: a capped list reported as a total tells an agent the
      // corpus is smaller than it is.
      const total = countSearch(ctx.db, a.query, a.projectId ?? undefined, a.filters ?? undefined)
      // An empty page from an offset past the 300 matched rows is otherwise
      // indistinguishable from "nothing matches" — and an agent would report the
      // second having caused the first.
      const pastTheCap = offset >= rows.length && total > rows.length
      return listScope(rows.slice(offset, offset + limit), total, {
        note:
          total === 0
            ? // A populated corpus that simply does not contain the query is the
              // ordinary empty result, for which the helpers return null. Saying
              // nothing would leave an agent unable to tell "no match" from
              // "nothing was searched", so name the query itself.
              (a.projectId
                ? scopeNote.emptyProject(ctx.db, a.projectId)
                : scopeNote.installCounts(ctx.db)) ??
              `Nothing matches ${JSON.stringify(a.query)}${
                a.projectId ? ` in project ${a.projectId}` : ''
              }. Words are matched literally — try fewer or broader ones, or papers_search_by_meaning.`
            : pastTheCap
              ? `${total} papers match, but the database returns only the first ${rows.length}; ` +
                `offset ${offset} is past them. Narrow with filters instead of paging.`
              : null,
        counts: null,
        limit,
        offset
      })
    }
  }),

  e({
    channel: 'search:count',
    tool: 'papers_search_count',
    access: 'read',
    summary:
      'How many papers match, counted in SQL and NOT capped — the honest total behind a ' +
      'papers_search result list, which is capped. Takes the same query and filters. ' +
      SEARCH_SEMANTICS,
    returns: 'number',
    params: z.object({
      query: querySchema,
      projectId: projectId.nullish(),
      filters: searchFiltersSchema
    }),
    order: ['query', 'projectId', 'filters'],
    run: (ctx, a) => countSearch(ctx.db, a.query, a.projectId ?? undefined, a.filters ?? undefined)
  }),

  e({
    channel: 'search:facets',
    tool: 'papers_search_facets',
    access: 'read',
    summary:
      'The values you can filter a project\u2019s papers by, with a count each: work_type, venue, ' +
      'year, inclusion_status and content_status. This is how you discover the legal values ' +
      'for papers_search\u2019s facet arrays instead of guessing them — every value returned here ' +
      'can be passed straight back. Year buckets are EXACT YEARS ("1998"); papers_search also ' +
      'accepts a decade label ("1990\u20131999", EN DASH) which this tool never emits. Each ' +
      'facet\u2019s counts are computed with that facet\u2019s own filter left out, so a count shows ' +
      'what selecting it WOULD add. Requires a real projectId (0 is the global sentinel, not a ' +
      `project). Each dimension is truncated to its ${FACET_BUCKETS} largest buckets, with the ` +
      'true bucket count beside them — a corpus can hold thousands of distinct venues.',
    returns: 'FacetsDTO',
    params: z.object({
      projectId,
      query: querySchema.nullish(),
      filters: searchFiltersSchema
    }),
    // NOTE the order: projectId FIRST here and query first in `search:query`.
    order: ['projectId', 'query', 'filters'],
    run: (ctx, a) =>
      // `?? ''` and not a schema default: the v3 handler did exactly this, and a
      // schema default would tell an agent an omitted query is illegal.
      getFacets(ctx.db, a.projectId, a.query ?? '', a.filters ?? undefined),
    shape: (result) => {
      const f = result as Record<string, Array<{ value: string; count: number }>>
      const out: Record<string, unknown> = {}
      for (const [key, buckets] of Object.entries(f)) {
        out[key] = {
          buckets: buckets.slice(0, FACET_BUCKETS),
          total_buckets: buckets.length
        }
      }
      return out
    }
  }),

  e({
    channel: 'search:web',
    tool: 'search_web',
    // `write` and not `read` even though it changes nothing here. The query text
    // LEAVES THE MACHINE, so a corpus this app exists to keep local can be
    // narrated out of it one search term at a time. A user who left the write
    // checkbox off is asking for a posture where nothing they hold travels, and
    // filing the one tool that transmits under "read" would defeat exactly that.
    access: 'write',
    slow: true,
    // NOT LISTED when nothing can answer it. Searching the outside world is done
    // by a plugin -- it happens inside the user's own browser, because several
    // indexes refuse a server -- so on an install with no such plugin this is a
    // capability the app genuinely does not have, and an agent should conclude
    // that rather than plan around a tool that always refuses.
    available: () => enabledPluginsWithCapability('paper-search').length > 0,
    summary:
      'Search EXTERNAL literature indexes for papers this corpus does NOT have, then hand a ' +
      'DOI from the result to an import tool to bring one in. Nothing here is in the ' +
      'corpus and nothing is imported by this call. THE QUERY TEXT LEAVES THIS MACHINE — it ' +
      'is sent verbatim to third-party services, so do not put anything from a paper, a note ' +
      'or the user\u2019s own writing into it that they would not publish. ' +
      'Goes over the network, so it is slow and ' +
      'can fail for reasons that have nothing to do with the query. sort "year" is ' +
      'newest-first and "year-asc" oldest-first. ' +
      'filters.sources narrows to papers a given index returned. WHICH indexes are searched ' +
      'depends on what this install has set up, so the values are not enumerable here -- ' +
      'read them off the `sources` field of the rows a first, unfiltered search returns; ' +
      'a paper is kept if ANY listed index returned it, and omitting it searches all of them. ' +
      'It filters what came BACK rather than choosing who is asked, so it makes a search no ' +
      'faster and no more private — every index is queried either way. A row also carries the ' +
      'preprint server it sits on (chemRxiv, Research Square…), which is filterable by the ' +
      'same field. An index that returned nothing for this query yields no rows rather than ' +
      'an error, so an empty result means THIS query, not that the index is absent. ' +
      'page is 1-based and is fetched UPSTREAM, so ' +
      'later pages cost another network round trip. Use it sparingly: a loop over pages is a ' +
      'crawl of somebody else\u2019s index.',
    returns: 'WebSearchResultDTO[]',
    params: z.object({
      query: querySchema,
      filters: z
        .object({
          yearFrom: z.number().int().min(1000).max(3000).optional(),
          yearTo: z.number().int().min(1000).max(3000).optional(),
          minCitations: z.number().int().min(0).optional(),
          author: z.string().max(200).optional(),
          // NOT an enum. Which indexes exist is the extension's to decide and it
          // attributes hits to preprint servers nothing queries directly, so a
          // closed list here would reject a source that is really in the results
          // the moment that repo adds one. Bounded instead of enumerated.
          sources: z.array(z.string().min(1).max(64)).max(32).optional(),
          sort: z.enum(['relevance', 'year', 'year-asc', 'citations']).optional(),
          // Capped so one search cannot ask the public indexes for an unbounded
          // page; the renderer pages instead of raising this.
          limit: z.number().int().min(1).max(200).optional(),
          page: z.number().int().min(1).max(100).optional(),
          projectId: z.number().int().positive().optional()
        })
        .nullish()
    }),
    order: ['query', 'filters'],
    clampArgs: (a) => ({
      ...a,
      filters: {
        ...(a.filters ?? {}),
        // Far below the channel's own ceiling. The UI pages a human's attention;
        // an agent loop would page a public index's rate limit.
        limit: cap(a.filters?.limit, 25),
        page: cap(a.filters?.page, 5)
      }
    }),
    run: async (ctx, a) => {
      // The default goes FIRST: spreading it after the caller's filters silently
      // overrode whatever they asked for, so a requested limit could never take
      // effect. That was a real bug.
      const hits = await getRetrieval().searchWeb(a.query, { limit: 100, ...(a.filters ?? {}) })
      const projectId = a.filters?.projectId
      // ASKED FOR, never assumed. Without a project there is no such thing as
      // "already added", and every row keeps the null it arrived with rather
      // than being marked against a corpus nobody named.
      if (projectId === undefined) return hits
      const held = findPapersInProject(
        ctx.db,
        projectId,
        hits.map((h) => ({ key: h.external_id, doi: h.doi, title: h.title }))
      )
      return hits.map((h) => ({ ...h, in_project_work_id: held.get(h.external_id) ?? null }))
    },
    shape: (result) => {
      const items = result as unknown[]
      return listScope(items, items.length, {
        note:
          items.length === 0
            ? 'The external indexes returned nothing for this query. This says nothing about what is in your corpus — use papers_search for that.'
            : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'search:semantic',
    tool: 'papers_search_by_meaning',
    access: 'read',
    slow: true,
    summary:
      'Search the corpus BY MEANING: the query is embedded and matched against passages of ' +
      'the papers\u2019 extracted text, so it finds wording it does not share. The unit is a ' +
      'PASSAGE, not a paper — each hit carries the verbatim text that matched and its raw ' +
      'cosine score. k is how many passages to ask for, a reading budget and NOT a claim ' +
      `about how many exist; omitting it gives ${CLAMP.k}. Set workId to search inside ONE ` +
      'paper (this is the by-meaning ' +
      'half of in-paper find); the narrowing happens inside the nearest-neighbour search, so ' +
      'that paper gets its own closest k rather than whatever survived a corpus-wide answer. ' +
      'A non-null "error" is a STATE, not a failure — no model packaged, no active vector ' +
      'space, a dimension mismatch after a model swap — and must be reported as such. ' +
      'Papers with no vector cannot appear in ANY result: read "coverage" before concluding ' +
      'something is absent from the corpus — semantic_coverage_get returns the same numbers ' +
      'with the FULL list of unsearchable papers, which is truncated here.',
    returns: 'SemanticSearchResultDTO',
    params: z.object({
      query: querySchema,
      projectId: projectId.nullish(),
      // Capped: a caller must not be able to ask the index for the whole corpus
      // and then hold it all in a structured clone.
      k: z.number().int().min(1).max(200).nullish(),
      // One paper's worth of passages, for the paper view's find bar.
      workId: z.number().int().nonnegative().nullish()
    }),
    order: ['query', 'projectId', 'k', 'workId'],
    // Each neighbour is an ONNX forward pass and the worker over-fetches by 20x
    // to survive scope filtering, so an agent's k is held well under the
    // channel's 200.
    clampArgs: (a) => ({ ...a, k: cap(a.k, CLAMP.k) }),
    run: (ctx, a) =>
      runSemanticSearch(ctx.db, getVectorSearch(), a.query, a.k ?? DEFAULT_K, {
        projectId: a.projectId ?? undefined,
        workId: a.workId ?? undefined
      }),
    shape: (result) => {
      const r = result as { coverage?: { unembedded?: unknown[] } }
      if (!r?.coverage?.unembedded) return result
      // The per-work unembedded list rides on EVERY semantic response with full
      // titles; at 200 entries beside k verbatim passages it is most of the
      // payload and none of the answer. The COUNT is the part that matters and
      // `unembedded_total` already carries it uncapped.
      return {
        ...(result as Record<string, unknown>),
        coverage: {
          ...r.coverage,
          unembedded: r.coverage.unembedded.slice(0, 10)
        }
      }
    }
  }),

  e({
    channel: 'search:semanticCoverage',
    tool: 'semantic_coverage_get',
    access: 'read',
    summary:
      'What a by-meaning search can and cannot currently see: how many papers are embedded, ' +
      'how many have text at all, how many exist in scope, and which specific papers have no ' +
      'vector and therefore cannot appear in ANY meaning result. Read this before reporting ' +
      'that the corpus contains nothing about a topic. A null "space" means nothing has ever ' +
      'been embedded, which is an honest answer and not an error.',
    returns: 'SemanticCoverageDTO',
    params: z.object({
      projectId: projectId.nullish(),
      workId: z.number().int().nonnegative().nullish()
    }),
    order: ['projectId', 'workId'],
    run: (ctx, a) =>
      semanticCoverage(ctx.db, {
        projectId: a.projectId ?? undefined,
        workId: a.workId ?? undefined
      })
  }),

  e({
    channel: 'search:listSaved',
    tool: 'search_history_list',
    access: 'read',
    summary:
      'The searches saved in this project, most recent first (capped at 25). Each carries the ' +
      'query and its filters as stored JSON, so a past search can be re-run exactly by ' +
      'feeding them back to papers_search. Useful for finding out what the human has already ' +
      'looked for before repeating it.',
    returns: 'SavedSearchDTO[]',
    params: z.object({ projectId }),
    order: ['projectId'],
    run: (ctx, a) => listSearchHistory(ctx.db, a.projectId),
    shape: (result) => {
      const items = result as unknown[]
      return listScope(items, items.length, {
        note: items.length === 0 ? 'No searches have been saved in this project yet.' : null,
        counts: null
      })
    }
  }),

  e({
    channel: 'search:record',
    tool: 'search_record',
    access: 'write',
    summary:
      'Save a search into the project\u2019s history so it can be re-run later. Re-recording an ' +
      'identical query and filters bumps the existing entry rather than duplicating it, and ' +
      'the history is trimmed to the newest 25. "filters" is the SearchFilters object ' +
      'serialized as JSON — serialize it the same way every time or the deduplication will ' +
      'not see the match. This writes to the human\u2019s own history: do not fill it with ' +
      'exploratory queries they did not ask for. If this call times out or your connection ' +
      'drops the write is NOT rolled back — read search_history_list back before retrying.',
    returns: 'SavedSearchDTO',
    // `params` is the v3 value space, unbounded strings and all: the renderer
    // saves whatever the human typed and a `.max()` here would start rejecting
    // names that work today. The bounds belong on the TOOL, where an unbounded
    // string is a memory amplifier — hence `toolParams`, which the sweep proves
    // is a strict narrowing of this.
    params: z.object({
      projectId,
      name: z.string().min(1),
      query: z.string(),
      filters: z.string().optional()
    }),
    toolParams: z.object({
      projectId,
      name: z.string().min(1).max(200),
      query: z.string().max(500),
      filters: z.string().max(4000).optional()
    }),
    run: (ctx, a) =>
      recordSearch(
        ctx.db,
        { projectId: a.projectId, name: a.name, query: a.query, filters: a.filters },
        nowIso()
      )
  })
]
