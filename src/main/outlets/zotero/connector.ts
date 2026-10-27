// Talk to a RUNNING Zotero over its own local HTTP server, so Zotero performs
// every write itself.
//
// THIS IS THE ONLY SAFE WAY TO PUT SOMETHING INTO A LIBRARY. `library.ts` reads
// a temp COPY of `zotero.sqlite` and must never write it: Zotero holds that file
// locked while it runs (a read-only connection to a live library fails outright
// with SQLITE_BUSY), its schema moves between versions, and a bad write corrupts
// a reference library that may represent years of work. Posting to the connector
// hands Zotero a request and lets Zotero's own code do the insert, in its own
// transaction — the same path its browser extension uses.
//
// MAIN PROCESS ONLY, and not by convention. Zotero's request handler REFUSES
// anything that looks like it came from a web page — a `User-Agent` beginning
// `Mozilla/`, or the presence of an `Origin` header — so the renderer's `fetch`
// cannot reach these endpoints at all. Ours is sent from Node with our own agent
// string and no origin.
//
// The server is on by default (`httpServer.enabled`, port 23119) and needs no
// setup from the user. The separate LOCAL API (`/api/`) is off by default and
// would cost an approval dialog and a key handshake, so nothing here uses it.

import { pathToFileURL } from 'node:url'

/** Where Zotero listens. Fixed: this is Zotero's own default and it has no discovery. */
const BASE = 'http://127.0.0.1:23119'

/**
 * Every request is short. This is a loopback call to a local app — a slow answer
 * means Zotero is busy or wedged, and waiting longer only makes the UI feel
 * broken. The PDF fetch is the deliberate exception: it reaches out to a
 * publisher over the network from inside Zotero.
 */
const PING_TIMEOUT_MS = 1500
const CALL_TIMEOUT_MS = 15_000
const FETCH_PDF_TIMEOUT_MS = 180_000

/**
 * A user agent that does NOT start with `Mozilla/`.
 *
 * Load-bearing, not cosmetic: Zotero treats a `Mozilla/` prefix as proof the
 * request came from a browser and rejects it before any endpoint runs.
 */
const AGENT = 'CorpusStudio'

/** One place a paper can be sent: a library root or a collection within it. */
export interface ZoteroTarget {
  /** Zotero's treeViewID — `L1` for a library, `C23` for a collection. */
  id: string
  name: string
  /** Nesting depth, so the UI can indent a child collection under its parent. */
  level: number
  /** False when Zotero will not accept file attachments here (a read-only group). */
  filesEditable: boolean
}

/** What a push needs to know about a paper. Nothing project-specific goes over. */
export interface ZoteroPushInput {
  title: string
  doi: string | null
  year: number | null
  venue: string | null
  /** Author names in order, already formatted as Zotero wants them. */
  creators: Array<{ firstName: string; lastName: string }>
  /** journal-article, preprint, … — mapped to a Zotero item type by the caller. */
  itemType: string
  /** A URL for the record, when one is known. */
  url: string | null
  /**
   * Absolute path of THIS app's copy of the PDF, when it holds one.
   *
   * Sent as bytes rather than asking Zotero to fetch its own copy. The two are
   * not equivalent: a resolver fetch can return a different version of the paper
   * — accepted manuscript instead of publisher PDF, a later revision — and every
   * evidence span, highlight and page reference in Corpus Studio is anchored to
   * the exact file here. Uploading what we have keeps the two libraries showing
   * the same document, and works for a paywalled paper the user supplied
   * themselves, which no resolver could ever find.
   */
  pdfPath: string | null
}

/** What actually happened, in terms the UI can state without guessing. */
export interface ZoteroPushResult {
  /** The item was created in Zotero. */
  created: boolean
  /** A PDF was attached. False is NORMAL — a paywalled paper has none to find. */
  attachedPdf: boolean
  /**
   * Why no PDF, when none was attached. `null` when one was.
   *
   * Distinguishes "Zotero looked and found nothing" from "we never asked",
   * because only the first is a statement about the paper.
   */
  pdfNote: string | null
}

/** Raised when Zotero is not answering. The caller decides what that means. */
export class ZoteroUnreachableError extends Error {
  constructor(cause?: unknown) {
    super('Zotero is not running, or its connector server is not answering.')
    this.name = 'ZoteroUnreachableError'
    this.cause = cause
  }
}

async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; text: string }> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': AGENT,
        ...extraHeaders
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    // A refused connection, a DNS-less loopback failure or a timeout all mean
    // the same thing to a caller: nothing is listening.
    throw new ZoteroUnreachableError(e)
  }
  return { status: res.status, text: await res.text() }
}

/**
 * POST raw bytes, for the one endpoint whose body is a file rather than JSON.
 *
 * Separate from `post` because the differences are not parameters: the body is
 * binary, the content type describes the FILE, and Zotero reads the metadata
 * from an `X-Metadata` header instead of the body. Folding both into one
 * function would mean a `typeof body === 'string'` branch deciding which
 * protocol is in use.
 */
async function postBytes(
  path: string,
  bytes: Uint8Array,
  contentType: string,
  metadata: unknown,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  // NODE'S `http`, NOT `fetch`. Zotero decides whether a request HAS a body from
  // `Content-Length` (`server.js`: `if (this.bodyLength > 0)`) and never reaches
  // the endpoint without one, so the byte count must arrive intact. `http.request`
  // sets it from the buffer it is handed, which takes the question out of play.
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}${path}`)
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          'User-Agent': AGENT,
          'Content-Length': bytes.byteLength,
          'X-Metadata': JSON.stringify(metadata)
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)))
    req.on('error', (e) => reject(new ZoteroUnreachableError(e)))
    req.end(bytes)
  })
}

/**
 * Is Zotero running right now?
 *
 * A QUESTION ABOUT THIS MOMENT, never a stored flag. Zotero can be quit at any
 * time, so a cached "connected" would let the UI claim a green light over an app
 * that closed an hour ago. Everything that shows connection state calls this.
 */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/connector/ping`, {
      method: 'GET',
      headers: { 'User-Agent': AGENT },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Every library and collection the user could send papers to.
 *
 * Read from Zotero LIVE rather than from `zotero.sqlite`, because the ids differ
 * and only these work here: the connector addresses a target by treeViewID
 * (`C23`), while the sqlite reader keys collections by their sync key
 * (`CSTEST0001`). Passing one where the other is expected silently targets
 * nothing, so the two must not be mixed — see `library.ts` for the read path.
 */
export async function listTargets(): Promise<ZoteroTarget[]> {
  const { status, text } = await post('/connector/getSelectedCollection', {}, CALL_TIMEOUT_MS)
  if (status !== 200) {
    throw new Error(`Zotero answered ${status} when asked for its collections.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Zotero’s reply about collections could not be read.')
  }
  const targets = (parsed as { targets?: unknown }).targets
  if (!Array.isArray(targets)) {
    // An answer we do not understand is reported as such. Returning [] would
    // state that the user has no collections, which is a claim about their
    // library that we have not established.
    throw new Error('Zotero’s reply about collections could not be read.')
  }
  return targets.flatMap((t) => {
    const o = t as Record<string, unknown>
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return []
    return [
      {
        id: o.id,
        name: o.name,
        level: typeof o.level === 'number' ? o.level : 0,
        filesEditable: o.filesEditable !== false
      }
    ]
  })
}

function sessionId(): string {
  // Zotero keys an in-flight save by this; it only has to be unique per call.
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

/**
 * Create a paper in Zotero, in `targetId`, with its full text.
 *
 * OUR metadata is authoritative. Zotero can recognise a PDF and derive its own
 * record, but then two databases hold different answers about the same paper and
 * neither is obviously right; sending what Corpus Studio already established
 * keeps this app the single source of that record.
 *
 * OUR BYTES ARE PREFERRED over anything Zotero could fetch. When `pdfPath` is
 * given, that exact file is uploaded — so the document in Zotero is the one this
 * app read, byte for byte, and a page or a highlight means the same thing in
 * both. Asking a resolver instead can return a different version of the paper
 * (accepted manuscript for publisher PDF, a later revision), and cannot help at
 * all with a paywalled paper the user supplied themselves.
 *
 * The resolver is the FALLBACK, for a paper whose file this app never got.
 * `hasAttachmentResolvers` is asked first because it is cheap and truthful: it
 * says whether a file is findable before committing to a slow download, so "no
 * full text" can be reported as the ordinary outcome it is.
 * `saveAttachmentFromResolver` answers a bare 500 when it finds nothing, which is
 * why that is read as "none found" rather than raised as a failure — a paywalled
 * paper is not a broken one.
 *
 * Either way the PDF step is NON-FATAL: the item exists in Zotero from the
 * moment `saveItems` returns, and a file that could not be sent leaves a
 * complete bibliographic record rather than nothing at all.
 */
export async function pushItem(
  input: ZoteroPushInput,
  targetId: string,
  opts: { fetchPdf: boolean } = { fetchPdf: true }
): Promise<ZoteroPushResult> {
  const sid = sessionId()
  const connectorKey = `corpus-${sid}`

  const item: Record<string, unknown> = {
    id: connectorKey,
    itemType: input.itemType,
    title: input.title,
    creators: input.creators.map((c) => ({
      firstName: c.firstName,
      lastName: c.lastName,
      creatorType: 'author'
    }))
  }
  // Absent fields are OMITTED, never sent empty. An empty string in Zotero's DOI
  // field is not the same as no DOI, and this app does not assert an identifier
  // it does not have.
  if (input.doi) item.DOI = input.doi
  if (input.venue) item.publicationTitle = input.venue
  if (input.year !== null) item.date = String(input.year)
  if (input.url) item.url = input.url

  const save = await post(
    '/connector/saveItems',
    { sessionID: sid, uri: input.url ?? '', items: [item] },
    CALL_TIMEOUT_MS
  )
  if (save.status !== 201) {
    throw new Error(`Zotero refused the paper (${save.status}).`)
  }

  // The TARGET is set after the save, which is how Zotero's own connector does
  // it: `saveItems` lands the item in whatever is currently selected, and this
  // moves the session — and the item with it — to the chosen collection.
  const upd = await post(
    '/connector/updateSession',
    { sessionID: sid, target: targetId },
    CALL_TIMEOUT_MS
  )
  if (upd.status !== 200) {
    throw new Error(`Zotero could not file the paper in the chosen collection (${upd.status}).`)
  }

  // OUR OWN FILE FIRST. Uploaded rather than fetched, so Zotero holds the same
  // bytes this app read — see the header. Failures here are reported, never
  // raised: the item is already in the library and a record without its file
  // beats no record at all.
  if (input.pdfPath !== null) {
    try {
      const { readFile } = await import('node:fs/promises')
      const bytes = await readFile(input.pdfPath)
      const sent = await postBytes(
        `/connector/saveAttachment?sessionID=${encodeURIComponent(sid)}`,
        bytes,
        'application/pdf',
        {
          sessionID: sid,
          parentItemID: connectorKey,
          title: 'Full Text',
          // REQUIRED AND MUST BE NON-EMPTY. Zotero's `importFromNetworkStream`
          // opens with `if (!options.url) throw`, and it also derives the stored
          // file's extension from this string — so an empty url is a 500 and a
          // url with no `.pdf` in it produces an attachment Zotero will not open
          // as a PDF. Sending the file's own location satisfies both and is
          // honest about where these bytes came from: this machine.
          url: pathToFileURL(input.pdfPath).href
        },
        FETCH_PDF_TIMEOUT_MS
      )
      if (sent.status === 201) return { created: true, attachedPdf: true, pdfNote: null }
      // A read-only group library answers 200 with a sentence rather than 201.
      return {
        created: true,
        attachedPdf: false,
        pdfNote:
          sent.status === 200 && sent.text.includes('not editable')
            ? 'Zotero will not accept files in that collection'
            : `Zotero would not take the file (${sent.status})`
      }
    } catch (e) {
      // THE UNDERLYING CAUSE IS CARRIED THROUGH, not collapsed to a category.
      // `postBytes` wraps every fetch failure as unreachable, so a first attempt
      // at this reported "Zotero stopped answering" for twenty papers while
      // Zotero was plainly running and answering — a sentence that sent the
      // debugging at the connection instead of at the request.
      if (e instanceof ZoteroUnreachableError) {
        const cause = e.cause instanceof Error ? `: ${e.cause.message}` : ''
        return {
          created: true,
          attachedPdf: false,
          pdfNote: `the file could not be sent${cause}`
        }
      }
      // An unreadable file on THIS side — an unmounted drive, a deleted file.
      // Named as ours rather than blamed on Zotero.
      return {
        created: true,
        attachedPdf: false,
        pdfNote: `this app could not read its own copy (${e instanceof Error ? e.message : String(e)})`
      }
    }
  }

  if (!opts.fetchPdf) {
    return { created: true, attachedPdf: false, pdfNote: 'not asked for' }
  }

  // Zotero resolves a PDF from the DOI (Unpaywall, PMC, the user's own
  // resolvers). With no DOI there is nothing for it to resolve from, so we do
  // not ask and say so, rather than reporting a search that never happened.
  if (!input.doi) {
    return { created: true, attachedPdf: false, pdfNote: 'no DOI to find a PDF from' }
  }

  let available = false
  try {
    const has = await post(
      '/connector/hasAttachmentResolvers',
      { sessionID: sid, itemID: connectorKey },
      CALL_TIMEOUT_MS
    )
    available = has.status === 200 && has.text.trim() === 'true'
  } catch (e) {
    // The paper IS in Zotero at this point. Losing the connection while asking
    // about a file must not report the whole push as failed.
    if (!(e instanceof ZoteroUnreachableError)) throw e
    return { created: true, attachedPdf: false, pdfNote: 'Zotero stopped answering' }
  }

  if (!available) {
    return { created: true, attachedPdf: false, pdfNote: 'Zotero found no open copy' }
  }

  try {
    const got = await post(
      '/connector/saveAttachmentFromResolver',
      { sessionID: sid, itemID: connectorKey },
      FETCH_PDF_TIMEOUT_MS
    )
    if (got.status === 201) return { created: true, attachedPdf: true, pdfNote: null }
    return { created: true, attachedPdf: false, pdfNote: 'Zotero could not download it' }
  } catch (e) {
    if (!(e instanceof ZoteroUnreachableError)) throw e
    return { created: true, attachedPdf: false, pdfNote: 'Zotero stopped answering' }
  }
}
