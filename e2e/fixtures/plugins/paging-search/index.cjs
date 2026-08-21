/*
 * A SEARCH SOURCE WITH A KNOWN ANSWER, so paging can be asserted rather than
 * eyeballed.
 *
 * The real search sources are public indexes reached through a browser
 * extension: they are rate-limited, they disagree with each other, and what they
 * return for a query today is not what they return tomorrow. None of that can
 * carry an assertion about whether page 3 repeats a paper from page 1.
 *
 * So this answers from a list it generates itself, with two properties the test
 * depends on:
 *
 *   - EVERY PAPER IS DISTINCT and its position in the corpus is readable from
 *     its own title ("Paging fixture paper 007"), so a duplicate across pages is
 *     visible as a repeated number rather than as two rows that look alike.
 *   - CONSECUTIVE FETCHES OVERLAP, deliberately. Real indexes page independently
 *     and return the same paper at different offsets, which is exactly what the
 *     app's cross-fetch dedup exists for. A fixture that paged cleanly would
 *     pass whether or not that dedup worked.
 *
 * It is a plugin rather than a stub inside the app because the app has no other
 * way to search: `paper-search` is a capability a folder offers, and a test that
 * bypassed the plugin path would be testing a path no user has.
 */

/** How many papers exist to be found. Fetching past the end returns nothing. */
const CORPUS = 400

/**
 * How far the window ADVANCES between one fetch and the next, in papers.
 *
 * Deliberately smaller than any limit the app asks for, which is what produces
 * the overlap: fetch 2 starts 60 papers in, so it re-offers everything from 61
 * onwards that fetch 1 already returned. Real indexes page independently and do
 * exactly this; a fixture that paged cleanly would pass whether or not the app's
 * cross-fetch dedup worked.
 *
 * An ABSOLUTE step rather than a fraction of `limit`, because the app does not
 * ask for the limit the reader sees: the search registry over-fetches from each
 * source and then slices. A fraction would be scaled by that over-fetch and the
 * overlap would vanish behind the slice — which is how this fixture first failed
 * to overlap at all.
 */
const STEP = 60

function paper(n) {
  const num = String(n).padStart(3, '0')
  return {
    id: `paging-${num}`,
    // Zero-padded so the corpus order and the alphabetical order are the same
    // one: the app sorts equal-scoring hits by title, and a test that asserted
    // "page 2 follows page 1" needs those two orders not to disagree.
    title: `Paging fixture paper ${num}`,
    // IDENTICAL for every paper, so no row scores above another and the order is
    // decided by the title alone.
    abstract: 'A fixture paper for exercising how search results are paged.',
    authors: ['Fixture, A.'],
    year: 2020,
    journal: 'Journal of Fixtures',
    citations: 0,
    type: 'journal-article'
  }
}

async function searchPapers(_ctx, _query, opts) {
  const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? opts.limit : 20
  const page = typeof opts?.page === 'number' && opts.page > 0 ? opts.page : 1
  const start = (page - 1) * STEP
  const hits = []
  for (let i = start; i < start + limit; i++) {
    if (i < 0 || i >= CORPUS) continue
    hits.push(paper(i + 1))
  }
  // ONE group, named, because the app distinguishes "an index looked and found
  // nothing" from "no index ran" by whether a group came back at all.
  return [{ index: 'fixture', hits }]
}

module.exports.default = function activate() {
  return {
    id: 'paging-search',
    blockers: () => [],
    warnings: () => [],
    values: () => ({}),
    secretsSet: () => ({}),
    onEnable: async () => {},
    onDisable: async () => {},
    configure: async () => ({ rejected: {} }),
    testConnection: async () => ({ ok: true, sentence: 'The fixture is ready.', code: null }),
    status: () => ({ state: 'idle', sentence: null, code: null, lastOkAt: null }),
    searchPapers
  }
}
