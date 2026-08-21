// Search source backed by the local MCP web-search server.
//
// This file is the ONLY place in the studio that knows that server exists, or
// what its wire format looks like. Everything it returns is already in the
// studio's canonical shape, so the registry, the IPC layer and the UI stay
// unaware of which upstream produced a row.
//
// The server is deliberately Corpus-Studio-agnostic: it exposes generic
// academic tools (CrossRef / PubMed Central / arXiv / bioRxiv) that other
// clients also use, so ALL of the bending happens here rather than there.

import { SERVER_SEARCH_SOURCES } from '../../../shared/searchSources'
import { normalizeHit, type RawHit } from '../normalize'
import type { SearchSource, SourceSearchOptions, WebSearchRecord } from '../types'

/** Academic indexes the server can fan out to. General web search is excluded. */
const ACADEMIC_SOURCES = SERVER_SEARCH_SOURCES

/**
 * CrossRef `type` values that are not papers.
 *
 * A `component` is a file ATTACHED to a paper — supplementary tables, figures,
 * SI PDFs — registered with its own DOI ending in `.s001`. They matched half of
 * the CrossRef hits on a real query, and each one is a trap: it carries a
 * plausible title (inherited from its parent paper) but no authors, no year and
 * no abstract, so it renders as a near-empty row that is nonetheless importable
 * and would enter the corpus as a junk work with nothing to analyse.
 *
 * Filtered here rather than in the server because this is CrossRef's private
 * vocabulary, and this adapter is the layer that is allowed to know it.
 */
const NON_PAPER_TYPES = new Set(['component', 'dataset', 'peer-review', 'grant'])

export interface WebSearchServerOptions {
  baseUrl: string
  /**
   * Whether the server should probe each result for a downloadable PDF.
   *
   * Off by default: the probe issues a network request PER RESULT and pushed an
   * interactive search past 30s in testing. Availability is not shown in the
   * results list, so the studio pays that cost for nothing — it resolves a PDF
   * at import time instead, for the one paper the user actually chose.
   */
  validateDownloads?: boolean
}

export interface McpEnvelope {
  result?: { content?: { type: string; text?: string }[] }
}

export class WebSearchServerSource implements SearchSource {
  readonly id = 'web-search-server'
  readonly label = 'Academic indexes (CrossRef, PubMed Central, arXiv, bioRxiv)'
  private readonly baseUrl: string
  private readonly validateDownloads: boolean

  constructor(opts: WebSearchServerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.validateDownloads = opts.validateDownloads ?? false
  }

  async search(query: string, opts: SourceSearchOptions): Promise<WebSearchRecord[]> {
    // The upstream indexes have no OR syntax, and passing our `|` through would
    // have them match the bar literally. Each alternative is therefore issued as
    // its own search; the registry dedups and re-ranks the union.
    const alternatives = query
      .split('|')
      .map((q) => q.trim())
      .filter((q) => q.length > 0)
    if (alternatives.length === 0) return []

    const perQuery = Math.max(4, Math.ceil(opts.limit / alternatives.length))
    const batches = await Promise.all(
      alternatives.map((q) => this.callPaperSearch(q, perQuery, opts.page, opts.signal))
    )

    const out: WebSearchRecord[] = []
    for (const batch of batches) {
      for (const hit of batch) {
        if (typeof hit.type === 'string' && NON_PAPER_TYPES.has(hit.type)) continue
        // The server tags each row with the index that produced it. Where it does, that
        // name is what the user is shown; where it does not, this adapter's own id is the
        // most specific origin anyone can honestly claim.
        const index = typeof hit.source === 'string' && hit.source.trim() ? hit.source.trim() : this.id
        const rec = normalizeHit(hit, this.id, index)
        if (rec) out.push(rec)
      }
    }
    return out
  }

  private async callPaperSearch(
    query: string,
    numResults: number,
    page: number,
    signal?: AbortSignal
  ): Promise<RawHit[]> {
    const envelope = await this.callTool(
      'paper_search_mode',
      {
        query,
        num_results: numResults,
        // The server offsets each index by (page-1)*num_results, so a later page
        // is fetched from the indexes rather than sliced out of this one.
        page,
        sources: ACADEMIC_SOURCES,
        validate_downloads: this.validateDownloads
      },
      signal
    )
    const payload = readToolJson(envelope, 'paper_search_mode')
    const results = payload.results
    // A MISSING `results` is a malformed answer; an EMPTY one is a real search
    // that found nothing. Only the second may be reported as zero hits.
    if (results === undefined || results === null) {
      throw new Error('the web-search server answered paper_search_mode with no results field')
    }
    if (!Array.isArray(results)) {
      throw new Error('the web-search server answered paper_search_mode with a results field that is not a list')
    }
    return results as RawHit[]
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<McpEnvelope> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } }),
        signal
      })
    } catch (e) {
      // An unreachable server surfaces from undici as a bare "fetch failed",
      // which tells the user nothing they can act on. Naming the server and its
      // address turns it into an instruction: start it, or point
      // CORPUS_WEBSEARCH_URL somewhere it is running.
      if (signal?.aborted) throw e
      const cause = e instanceof Error ? e.message : String(e)
      throw new Error(`the web-search server at ${this.baseUrl} is not reachable (${cause})`)
    }
    if (!res.ok) {
      // The server reports tool errors as a JSON body on a 500; surfacing that
      // message beats a bare status code when diagnosing a dead upstream.
      let detail = ''
      try {
        const body = (await res.json()) as { error?: string }
        detail = body.error ? `: ${body.error}` : ''
      } catch {
        /* non-JSON error body — the status alone will have to do */
      }
      throw new Error(`web-search ${name} failed (HTTP ${res.status})${detail}`)
    }
    return (await res.json()) as McpEnvelope
  }
}

/**
 * Unwrap an MCP tool response.
 *
 * MCP returns tool output as TEXT content, so the actual JSON payload is a
 * string nested inside the envelope and has to be parsed a second time.
 *
 * A tool that answered with something this cannot read THROWS, and that is the
 * point. Returning null made a MALFORMED source indistinguishable from a source
 * that ran and found nothing: the registry saw a fulfilled promise carrying an
 * empty array, counted it a success, and the user was shown "no results" for a
 * search that never actually happened. Thrown, it becomes a `SourceFailure`
 * like every other — the same banner, the same partial-results rule, and the
 * same refusal to present zero rows as an answer when every source failed.
 *
 * The message names the tool and the shortfall, never the body: a malformed
 * payload is upstream-controlled text and this string reaches the screen.
 */
export function readToolJson(envelope: McpEnvelope, tool: string): Record<string, unknown> {
  const text = envelope.result?.content?.find((c) => c.type === 'text')?.text
  if (!text) {
    throw new Error(`the web-search server answered ${tool} with no result content`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the web-search server answered ${tool} with a result this app cannot read`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`the web-search server answered ${tool} with a result of an unexpected shape`)
  }
  return parsed as Record<string, unknown>
}
