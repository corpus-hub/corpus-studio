// The three indexes that will answer "what does this paper cite", and the
// shaping of their replies.
//
// IN THE APP, not in the extension, on purpose. The extension exists because
// publishers serve a JS challenge that only a real browser can satisfy; none of
// these three do. They are plain anonymous JSON APIs with CORS open, so routing
// them through the browser would add a socket hop, a second failure mode and a
// dependency on the user having installed anything — for no capability.
//
// Every function here is a pure translation of one HTTP reply into
// `ExternalReferenceResult`. No merging, no dedup, no matching: those are
// `reconcile.ts`'s job and keeping them out means a source can be added by
// writing one function.

import { normalizeDoi } from '../../citations/normalize'
import { recoverOrdinals } from './ordinals'
import type { ExternalReference, ExternalReferenceResult, ReferenceSource } from './types'

/**
 * Identifies this client to the indexes that ask to be identified.
 *
 * Crossref's "polite pool" is a real, measurable difference — an unidentified
 * caller is routed to a shared pool that rate-limits into multi-second waits,
 * which `src/main/search/registry.ts` already documents as the reason its own
 * timeout had to be raised to five minutes. OpenAlex asks for the same thing
 * for the same reason.
 *
 * `contactEmail(db)` supplies it — a per-install random address at a domain that
 * really resolves, never one derived from the machine. See `contact.ts` for why
 * a hostname or machine-id hash would be worse than random. Threaded as a
 * parameter rather than read here so this module stays free of the DB.
 */
export interface FetchOptions {
  mailto?: string
  /** Aborts a single index, not the batch. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Injected by tests so a backoff costs no wall-clock. */
  sleepImpl?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long to wait out a BUSY index, and how many times.
 *
 * BEING TOLD TO COME BACK LATER IS NOT AN ANSWER ABOUT A PAPER, and that is the
 * whole reason this exists rather than letting the status fall through. Every
 * caller turns a failed request into a claim — "no index could be reached for
 * this reference" — and one bibliography puts hundreds of requests to one index
 * in a row, so a single unretried refusal writes that claim across a whole
 * bibliography from a corpus whose only fault was arriving while the server was
 * unwell.
 *
 * 429 AND 5xx ALIKE. Crossref returned 503 in the middle of a corpus-wide
 * re-fetch: the same transient "not now" as a rate limit, differing only in
 * whose fault it is, and 503 fell straight through to `unreachable` while 429
 * was patiently retried. A 500, 502, 503 or 504 says nothing whatever about the
 * paper being asked about, so none of them may end the attempt.
 *
 * A 4xx OTHER THAN 429 IS NOT RETRIED, and that distinction is the point: 404
 * is the index answering that it holds no such record, which IS an answer, and
 * asking again would only produce it more slowly.
 *
 * Doubling from a second, three attempts. An index still refusing after seven
 * seconds is busy in a way waiting will not fix, and "it did not answer" is
 * then the honest report. `Retry-After` beats the schedule whenever the server
 * sends one: it is the only party that knows.
 */
const RATE_LIMIT_ATTEMPTS = 3
const RATE_LIMIT_BASE_MS = 1000

/** Transient by definition: the server is saying "not now", not "no". */
const isTransient = (status: number): boolean => status === 429 || status >= 500
/** A server asking for longer than this is one to give up on, not to sit out. */
const RATE_LIMIT_MAX_WAIT_MS = 30_000

/** `Retry-After` as milliseconds. Seconds or an HTTP date; both are legal. */
function retryAfterMs(res: { headers?: { get?: (n: string) => string | null } }): number | null {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RATE_LIMIT_MAX_WAIT_MS)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  return Math.min(Math.max(0, at - Date.now()), RATE_LIMIT_MAX_WAIT_MS)
}

function fail(source: ReferenceSource, error: string): ExternalReferenceResult {
  return { source, ok: false, error, declaredCount: null, references: [] }
}

/**
 * One request, with the timeout applied to the WHOLE exchange.
 *
 * `AbortController` rather than `Promise.race`: a raced timeout resolves the
 * caller but leaves the socket open, and a batch over 21 papers leaves 21 of
 * them.
 */
export async function getJson(
  url: string,
  opts: FetchOptions
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const doFetch = opts.fetchImpl ?? fetch
  const wait = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  for (let attempt = 0; ; attempt++) {
    // A FRESH CONTROLLER PER ATTEMPT: an aborted one stays aborted, so reusing
    // it would fail the retry before the socket opened. The timeout bounds one
    // exchange, not the whole sequence.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } })
      if (isTransient(res.status) && attempt < RATE_LIMIT_ATTEMPTS - 1) {
        clearTimeout(timer)
        await wait(retryAfterMs(res) ?? RATE_LIMIT_BASE_MS * 2 ** attempt)
        continue
      }
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      return { ok: true, body: await res.json() }
    } catch (err) {
      const e = err as Error
      return { ok: false, error: e.name === 'AbortError' ? 'timed out' : `${e.name}: ${e.message}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

function year(v: unknown): number | null {
  const s = text(v)
  if (!s) return null
  const m = /\b(1[6-9]\d{2}|20\d{2})\b/.exec(s)
  return m ? Number(m[1]) : null
}

function doi(v: unknown): string | null {
  const s = text(v)
  return s ? normalizeDoi(s) : null
}

// ------------------------------------------------------------------ crossref

/**
 * Crossref's `reference` array — the richest of the three and the only one that
 * carries anything positional.
 *
 * It returns the reference as the PUBLISHER deposited it, which is why fields
 * are so unevenly populated: `article-title` is absent from most Springer
 * deposits (the title lives inside `unstructured` instead), `author` is one
 * surname, and roughly 8% of entries have no DOI at all. Nothing is
 * back-filled here — an absent field stays null and the reconciler decides
 * whether another source or the printed entry can supply it.
 */
export async function crossrefReferences(
  workDoi: string,
  opts: FetchOptions = {}
): Promise<ExternalReferenceResult> {
  const u = new URL(`https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(workDoi))}`)
  // `select` is not used: Crossref ignores it for single-work reads, and asking
  // for a subset that it silently disregards would make the payload size look
  // like a bug rather than the documented behaviour it is.
  if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

  const r = await getJson(u.toString(), opts)
  if (!r.ok) return fail('crossref', r.error)

  const msg = (r.body as { message?: Record<string, unknown> }).message
  if (!msg) return fail('crossref', 'reply had no message')

  const raw = Array.isArray(msg.reference) ? (msg.reference as Array<Record<string, unknown>>) : []
  const ordinals = recoverOrdinals(raw.map((x) => text(x.key)))

  const references: ExternalReference[] = raw.map((x, i) => ({
    source: 'crossref',
    ordinal: ordinals[i],
    doi: doi(x.DOI),
    title: text(x['article-title']) ?? text(x['volume-title']),
    authors: text(x.author),
    year: year(x.year),
    venue: text(x['journal-title']),
    volume: text(x.volume),
    // Crossref deposits only the first page. Rendering it as a range would be
    // an invention; it is stored as what it is.
    pages: text(x['first-page']),
    unstructured: text(x.unstructured)
  }))

  const declared = typeof msg['reference-count'] === 'number' ? (msg['reference-count'] as number) : null
  return { source: 'crossref', ok: true, error: null, declaredCount: declared, references }
}

// ------------------------------------------------------------------ openalex

/**
 * OpenAlex `referenced_works` — RESOLVED ids, which is a different kind of
 * answer from Crossref's.
 *
 * Each entry is an OpenAlex work id, not a citation string, so OpenAlex has
 * already done the matching that this app otherwise does itself. That is the
 * value and also the limit: it can tell you the cited paper's DOI and title
 * exactly, and it can tell you NOTHING about where in the bibliography it sat,
 * because it is not reading a bibliography. Every `ordinal` from this source is
 * null and always will be.
 *
 * Costs one extra request: the ids come back bare, and turning ~50 of them into
 * DOIs is a second call to the `works` filter endpoint. Batched at 50 (the
 * documented `|` limit) rather than requested individually.
 */
export async function openAlexReferences(
  workDoi: string,
  opts: FetchOptions = {}
): Promise<ExternalReferenceResult> {
  const u = new URL(`https://api.openalex.org/works/https://doi.org/${normalizeDoi(workDoi)}`)
  if (opts.mailto) u.searchParams.set('mailto', opts.mailto)

  const r = await getJson(u.toString(), opts)
  if (!r.ok) return fail('openalex', r.error)

  const ids = (r.body as { referenced_works?: unknown }).referenced_works
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
  if (list.length === 0) {
    return { source: 'openalex', ok: true, error: null, declaredCount: 0, references: [] }
  }

  const references: ExternalReference[] = []
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50).map((id) => id.replace(/^https?:\/\/openalex\.org\//, ''))
    const b = new URL('https://api.openalex.org/works')
    b.searchParams.set('filter', `openalex:${batch.join('|')}`)
    b.searchParams.set('per-page', '50')
    b.searchParams.set(
      'select',
      'id,doi,title,publication_year,authorships,primary_location,biblio'
    )
    if (opts.mailto) b.searchParams.set('mailto', opts.mailto)

    const rb = await getJson(b.toString(), opts)
    if (!rb.ok) {
      // A batch that fails is REPORTED, not skipped. Returning the partial list
      // as though it were complete would make "this paper cites 30 works" out
      // of a paper that cites 50, and nothing downstream could tell.
      return fail('openalex', `hydration failed: ${rb.error}`)
    }
    const results = (rb.body as { results?: unknown }).results
    const rows = Array.isArray(results) ? (results as Array<Record<string, unknown>>) : []
    for (const w of rows) {
      const auth = Array.isArray(w.authorships) ? (w.authorships as Array<Record<string, unknown>>) : []
      const names = auth
        .map((a) => text((a.author as Record<string, unknown> | undefined)?.display_name))
        .filter((n): n is string => n !== null)
      const loc = w.primary_location as Record<string, unknown> | undefined
      const src = loc?.source as Record<string, unknown> | undefined
      const bib = w.biblio as Record<string, unknown> | undefined
      const first = text(bib?.first_page)
      const last = text(bib?.last_page)
      references.push({
        source: 'openalex',
        ordinal: null,
        doi: doi(w.doi),
        title: text(w.title),
        authors: names.length > 0 ? names.join('; ') : null,
        year: typeof w.publication_year === 'number' ? (w.publication_year as number) : null,
        venue: text(src?.display_name),
        volume: text(bib?.volume),
        pages: first && last ? `${first}-${last}` : first,
        unstructured: null
      })
    }
  }

  return {
    source: 'openalex',
    ok: true,
    error: null,
    // The id list is what OpenAlex claims; the hydrated rows are what came
    // back. They differ when a referenced work has been merged or withdrawn,
    // and that is worth being able to see.
    declaredCount: list.length,
    references
  }
}

// ------------------------------------------------------------- opencitations

/**
 * OpenCitations COCI — DOI pairs, and nothing else.
 *
 * The thinnest source by far: it returns `{citing, cited}` and no metadata at
 * all, so every reference from it has a DOI and null everything. That makes it
 * useless as a primary source and valuable as a CHECK — it is built from
 * Crossref's open references plus deposits Crossref itself does not expose, so
 * a DOI here that is absent from the other two is a real gap in them.
 *
 * Kept last for that reason: it can confirm and it can add an identifier, but a
 * reference known only to COCI cannot be shown to a user as anything but a DOI.
 */
export async function openCitationsReferences(
  workDoi: string,
  opts: FetchOptions = {}
): Promise<ExternalReferenceResult> {
  const d = normalizeDoi(workDoi)
  const r = await getJson(`https://opencitations.net/index/coci/api/v1/references/${d}`, opts)
  if (!r.ok) return fail('opencitations', r.error)

  const rows = Array.isArray(r.body) ? (r.body as Array<Record<string, unknown>>) : []
  const references: ExternalReference[] = rows
    .map((x) => doi(x.cited))
    .filter((c): c is string => c !== null)
    .map((c) => ({
      source: 'opencitations' as const,
      ordinal: null,
      doi: c,
      title: null,
      authors: null,
      year: null,
      venue: null,
      volume: null,
      pages: null,
      unstructured: null
    }))

  return {
    source: 'opencitations',
    ok: true,
    error: null,
    declaredCount: references.length,
    references
  }
}

/**
 * Ask every index, and report what each one said.
 *
 * Sequential, not `Promise.all`. Three simultaneous unkeyed requests to three
 * rate-limited public APIs, repeated across a corpus, is how a polite-pool
 * caller gets moved out of the polite pool. The whole batch for 21 papers runs
 * in well under a minute serially, and nothing here is on an interactive path.
 *
 * A failing index does not fail the call: the result array always has one entry
 * per source, so the caller can distinguish "OpenAlex says this paper cites
 * nothing" from "OpenAlex did not answer".
 */
export async function fetchAllSources(
  workDoi: string,
  opts: FetchOptions = {}
): Promise<ExternalReferenceResult[]> {
  return [
    await crossrefReferences(workDoi, opts),
    await openAlexReferences(workDoi, opts),
    await openCitationsReferences(workDoi, opts)
  ]
}
