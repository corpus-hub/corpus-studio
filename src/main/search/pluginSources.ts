// Turning the plugins that can search into `SearchSource`s.
//
// This is the ONE place a plugin's raw hits become the studio's canonical shape,
// and the direction is the one `types.ts` argues for: the app owns what a search
// result IS, a source owns only how to obtain hits and what its upstream's
// fields mean. A plugin that shipped finished `WebSearchRecord`s would be a
// second implementation of that decision, free to disagree with it silently and
// only in the corpus.
//
// NAMES NO PLUGIN. The set is `enabledPluginsWithCapability('paper-search')`,
// asked fresh on every search, so a second search plugin is reached on exactly
// the path the first one is and a disabled one is not reached at all.

import {
  enabledPluginsWithCapability,
  pluginCapabilityVerb,
  pluginCtx,
  pluginSignal
} from '../plugins/host'
import { PAPER_SEARCH_OFF_SENTENCE } from '../../shared/contract/plugins'
import { normalizeHit, type RawHit } from './normalize'
import type { SearchSource, SourceSearchOptions, WebSearchRecord } from './types'

/**
 * One group as a plugin reports it: which index ran, and what it produced.
 *
 * Mirrors the plugin-side `PaperSearchGroup`. Everything here is a STRANGER'S
 * VALUE and is treated as one below — the shape is what we hope for, not what we
 * assume.
 */
interface RawGroup {
  index?: unknown
  error?: unknown
  hits?: unknown
}

/** Longest an index id may be. It becomes part of a stored `external_id`. */
const INDEX_MAX = 64

/**
 * An index id, bounded to what it is used as.
 *
 * It is written into `external_id` (`<plugin>:<index>`) and rendered as an
 * attribution, so it is held to a slug: no separators that could collide with
 * the namespacing, no control or bidi characters, nothing unbounded. An id that
 * fails this does not disqualify its hits — it falls back to the plugin's own
 * id, because WHICH index answered is a detail and WHETHER the paper was found
 * is not.
 */
function shapeIndex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const s = raw.trim()
  if (s.length === 0 || s.length > INDEX_MAX) return fallback
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(s) ? s : fallback
}

/** A plugin's error text, bounded. Never rendered; it goes into a failure message. */
function shapeError(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
  return s.length === 0 ? null : s.slice(0, 300)
}

/**
 * A source backed by one plugin.
 *
 * The failure contract the app relies on is applied HERE rather than trusted to
 * the plugin, because it is the difference between "no papers match" and "the
 * search never ran" — and a plugin that got it wrong would make the UI conclude
 * something about a query nothing answered.
 */
class PluginSearchSource implements SearchSource {
  /** Diagnostics only. A plugin's own name is not read here — the id is its identity. */
  readonly label: string

  constructor(readonly id: string) {
    this.label = `search plugin ${id}`
  }

  async search(query: string, opts: SourceSearchOptions): Promise<WebSearchRecord[]> {
    // The plugin's OWN abort signal, combined with the caller's. The first stops
    // the call when the plugin is disabled mid-search; the second is the app's
    // per-source deadline and a superseded query. Without the first, disabling a
    // plugin left its socket open and its rows still merging into the answer.
    const ctx = pluginCtx(this.id)
    const own = pluginSignal(this.id)
    const signal = combineSignals(opts.signal, own)

    const raw = await pluginCapabilityVerb<unknown>(
      this.id,
      'searchPapers',
      PAPER_SEARCH_OFF_SENTENCE,
      ctx,
      query,
      {
        limit: opts.limit,
        page: opts.page,
        yearFrom: opts.yearFrom,
        yearTo: opts.yearTo,
        author: opts.author,
        signal
      }
    )

    if (!Array.isArray(raw)) {
      throw new Error(`${this.id} answered with something that is not a list of indexes`)
    }
    const groups = raw as RawGroup[]

    // A per-index error is not fatal ON ITS OWN — one index being down costs its
    // own rows and the rest of the query still returns. But EVERY index failing
    // is not "no results", it is a broken search: returning [] for it made the UI
    // say "No papers match / Relax a filter" about a search that never ran. The
    // registry's total-failure guard only covers a source that THROWS.
    const failed = groups.filter((g) => shapeError(g.error) !== null)
    if (groups.length > 0 && failed.length === groups.length) {
      const detail = failed
        .map((g) => `${shapeIndex(g.index, '?')}: ${shapeError(g.error)}`)
        .join('; ')
      throw new Error(`every index failed -- ${detail}`)
    }
    // NO GROUPS AT ALL is the same fact, not the empty one. A group is emitted
    // per index that RAN, error or not, so none means nothing ran — and that is
    // only "no results" when at least one index looked and found nothing.
    if (groups.length === 0) {
      throw new Error(`no index answered -- ${this.id} returned no result groups`)
    }

    const out: WebSearchRecord[] = []
    for (const group of groups) {
      if (shapeError(group.error) !== null) continue
      const index = shapeIndex(group.index, this.id)
      const hits = Array.isArray(group.hits) ? group.hits : []
      for (const hit of hits) {
        if (typeof hit !== 'object' || hit === null) continue
        // `normalizeHit` owns the canonical shape and already tolerates the field
        // disagreements between indexes, so this only hands it the raw names —
        // and it is what bounds and validates every field, so a hostile hit is
        // rejected there rather than stored.
        const record = normalizeHit(
          hit as RawHit,
          // NAMESPACED so `external_id` stays unique and stable per plugin and
          // index. Both halves are shaped: the plugin id is `[a-z][a-z0-9-]*` by
          // the manifest, the index by `shapeIndex` above.
          `${this.id}:${index}`,
          // WHERE THE PAPER LIVES, not which index answered. A hit Crossref
          // returned may sit on chemRxiv, and that is what tells a reader whether
          // it has been peer-reviewed.
          shapeIndex((hit as { host?: unknown }).host, index)
        )
        if (record) out.push(record)
      }
    }
    return out
  }
}

/**
 * Two signals as one, without leaking a listener per search.
 *
 * `AbortSignal.any` is available on Node 20 and is the whole of what this needs;
 * it is wrapped only so an absent second signal is an ordinary case rather than
 * a branch at every call site.
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal | null): AbortSignal | undefined {
  const both = [a, b].filter((s): s is AbortSignal => s != null)
  if (both.length === 0) return undefined
  if (both.length === 1) return both[0]
  return AbortSignal.any(both)
}

/**
 * Every enabled plugin that can search, as sources.
 *
 * Asked FRESH on every search. A cached list would go on reaching a plugin the
 * user disabled thirty seconds ago, which is the state the enabled flag exists
 * to prevent.
 */
export function pluginSearchSources(): SearchSource[] {
  return enabledPluginsWithCapability('paper-search').map((id) => new PluginSearchSource(id))
}
