// A document's TEXT, as the app currently stands behind it.
//
// Three reads share one question — "which stage run owns this document's
// paragraph inventory right now?" — and answering it in one place is the whole
// point of this module. The summary writes its prose from that inventory; the
// find and the range read must be searching the SAME text, or an agent cites an
// offset into paragraphs the app no longer publishes.
//
// The inventory lives in two shapes, written by ONE run of the `segment` stage:
//   * `stage_artifact` key `text.paragraphs@v1` — the canonical JSON blob,
//     which is what the summary hashes for staleness.
//   * `document_paragraph` rows — the same paragraphs, indexed by
//     `(document_id, idx)` and `(document_id, char_start)`.
// Reads that PAGE go to the rows: a 500-page paper's artifact is megabytes and
// `JSON.parse` of it runs on the main thread, blocking every other channel and
// the window with it. Reads that need the exact canonical string go to the blob.
// Both resolve the run id here, so they cannot disagree about which text is
// current even though they read different tables.
//
// More than ONE live inventory is reported, never silently resolved. The
// partial-unique index on `stage_run` is per stage, so a second provider (an OCR
// transformer) can legitimately publish a second current inventory — and picking
// the newest would answer a question nobody asked. `freshness.ts:117-128`
// already refuses in exactly this case; refusing identically keeps the two from
// describing the same document differently.

import type { DB } from '../connection'
import type {
  DocumentParagraphDTO,
  DocumentTextDTO,
  DocumentTextState,
  TextHitDTO,
  TextSearchDTO
} from '@shared/contract'

/**
 * A paragraph as the `segment` stage published it.
 *
 * An ALIAS of the contract's DTO rather than a second declaration: these rows
 * cross IPC unchanged, and two hand-copied shapes with nothing linking them
 * drift the first time a field is added to one of them.
 */
export type ParagraphRow = DocumentParagraphDTO

/**
 * Why a document has no readable text.
 *
 * Five distinct states, kept distinct: "this work has no PDF at all" and "the
 * PDF is here but its text has not been extracted yet" have different remedies,
 * and collapsing them into one `no-text` would tell a user to ingest a file they
 * already have. Aliased from the contract so the states cannot diverge.
 */
export type TextState = DocumentTextState

/** The run that currently owns a document's paragraph inventory. */
export interface CurrentTextRun {
  state: Exclude<TextState, 'empty-text'>
  /** Null unless `state === 'ok'`. */
  stageRunId: number | null
  /**
   * The NEWEST live inventory, even when there is more than one.
   *
   * Separate from `stageRunId` on purpose: a caller that must produce something
   * (the summary, which has always taken the newest and predates this refusal)
   * reads this, and a caller that anchors offsets an agent will cite reads
   * `stageRunId` and gets null. One field for both would force one of the two to
   * be wrong.
   */
  newestRunId: number | null
  /** How many live inventories were found. >1 is `ambiguous-text`. */
  runCount: number
}

/**
 * Resolve a work to the document its text should be read from.
 *
 * `is_preferred DESC, id ASC` — the same order `summary.ts:resolveSourceText`
 * and `listJobs`' thumbnail join use. A work may hold several documents (a
 * preprint and the published version), and two reads picking different ones
 * would quote page 4 of one paper against page 4 of another.
 */
export function preferredDocumentId(db: DB, workId: number): number | null {
  const row = db
    .prepare(
      `SELECT id FROM document
        WHERE work_id = ?
        ORDER BY is_preferred DESC, id ASC
        LIMIT 1`
    )
    .get(workId) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * Which stage run currently publishes this document's paragraphs.
 *
 * Keyed on the ARTIFACT rather than on the stage id, because the contract the
 * readers depend on is "something published `text.paragraphs@v1`", not "the
 * `segment` stage ran". A transformer that republishes the inventory satisfies
 * the first and not the second.
 */
export function currentTextRun(db: DB, documentId: number): CurrentTextRun {
  const runs = db
    .prepare(
      /* sql */ `
      SELECT sr.id
        FROM stage_artifact sa
        JOIN stage_run sr ON sr.id = sa.stage_run_id
       WHERE sa.key = 'text.paragraphs@v1'
         AND sr.document_id = ?
         AND sr.superseded = 0
         AND sr.status = 'succeeded'
       ORDER BY sr.id DESC
    `
    )
    .all(documentId) as Array<{ id: number }>

  if (runs.length === 0) {
    return { state: 'no-text', stageRunId: null, newestRunId: null, runCount: 0 }
  }
  if (runs.length > 1) {
    return {
      state: 'ambiguous-text',
      stageRunId: null,
      newestRunId: runs[0].id,
      runCount: runs.length
    }
  }
  return { state: 'ok', stageRunId: runs[0].id, newestRunId: runs[0].id, runCount: 1 }
}

/**
 * The canonical paragraph inventory for a document, parsed.
 *
 * The RAW paragraphs, exactly as published — no bibliography filter, no
 * truncation, no joining. Every one of those is a decision belonging to the
 * caller: `summary.ts` drops references because a model shown eighty citations
 * summarises the field rather than the paper, while a find that dropped them
 * could not locate a cited author's name, which is one of the things a reader
 * searches a paper for. Pushing either policy in here would make one of the two
 * callers wrong.
 *
 * Takes the NEWEST live inventory rather than refusing when there are several,
 * which is what the summary has always done. The refusal belongs to the reads
 * whose OFFSETS are cited (`findInDocument`, `getDocumentText`): an ambiguous
 * anchor is a wrong citation, while an ambiguous summary is merely a summary of
 * the newer of two texts. `runCount` comes back so a caller that wants the
 * stricter answer can have it.
 *
 * `corrupt` distinguishes the two ways there is no inventory, because they have
 * DIFFERENT REMEDIES. Nothing extracted yet is fixed by extracting; an artifact
 * that will not parse is fixed by extracting AGAIN, and until someone does, this
 * paper's full text is unreachable while the paper itself looks perfectly
 * ordinary. Collapsed into one null, the second was invisible: a summary
 * silently fell back to the abstract and badged itself "abstract only", which is
 * honest about WHAT it read and says nothing about the extracted text sitting
 * unreadable behind it.
 */
export interface ParagraphInventory {
  stageRunId: number
  runCount: number
  /**
   * `index` is the paragraph's `document_paragraph.idx`, and it is what makes a
   * FILTERED body anchorable: a caller that drops the bibliography renumbers
   * everything after it, so the model's `[p47]` is the 47th paragraph of the
   * prose while the reader's `[p47]` is the 47th of the whole paper. Carrying it
   * lets that caller hand the pipeline a map back.
   */
  paragraphs: Array<{ kind?: string; text?: string; index?: number }>
}

export function currentParagraphInventory(db: DB, documentId: number): ParagraphInventory | null {
  return readParagraphInventory(db, documentId).inventory
}

/** The same read, saying WHY there is no inventory when there is none. */
export function readParagraphInventory(
  db: DB,
  documentId: number
): { inventory: ParagraphInventory | null; corrupt: boolean } {
  const run = currentTextRun(db, documentId)
  if (run.newestRunId === null) return { inventory: null, corrupt: false }
  const art = db
    .prepare(`SELECT json FROM stage_artifact WHERE stage_run_id = ? AND key = 'text.paragraphs@v1'`)
    .get(run.newestRunId) as { json: string } | undefined
  if (!art) return { inventory: null, corrupt: false }
  try {
    const parsed = JSON.parse(art.json) as { paragraphs?: Array<{ kind?: string; text?: string }> }
    return {
      inventory: {
        stageRunId: run.newestRunId,
        runCount: run.runCount,
        paragraphs: parsed.paragraphs ?? []
      },
      corrupt: false
    }
  } catch {
    // A corrupt artifact is not a reason to FAIL a read — the caller still
    // degrades to the abstract — but it is a reason to SAY so. The stored bytes
    // are never quoted anywhere: only the fact.
    return { inventory: null, corrupt: true }
  }
}

/**
 * Every paragraph of a document, unbounded, for anchoring a highlight.
 *
 * The Paper screen scopes an evidence highlight to the paragraph its span
 * names, which is what lets a value far too short to locate document-wide — a
 * table cell of eight canonical characters — be highlighted at all.
 *
 * Unbounded, unlike `getDocumentText`, whose 20 000-character / 400-paragraph
 * page is right for a reader and wrong here: a paragraph that falls off the end
 * of the page silently costs its highlights, and the papers most likely to
 * exceed it are the long table-heavy ones this exists for.
 *
 * Refuses an ambiguous inventory rather than taking the newest, because this
 * read's OFFSETS are cited — the rule stated for `findInDocument` and
 * `getDocumentText` above. Scoping to a paragraph from the wrong inventory
 * would anchor a quote to text no analysis ever read.
 */
export function paragraphTexts(db: DB, documentId: number): Array<{ idx: number; text: string }> {
  const run = currentTextRun(db, documentId)
  if (run.stageRunId === null) return []
  return db
    .prepare(
      /* sql */ `
      SELECT idx, text
        FROM document_paragraph
       WHERE stage_run_id = ?
       ORDER BY idx
    `
    )
    .all(run.stageRunId) as Array<{ idx: number; text: string }>
}

/** Resolve `{workId}` or `{documentId}` to a document, uniformly. */
function resolveDocument(
  db: DB,
  ref: { workId?: number; documentId?: number }
): { documentId: number | null; workId: number | null; contentStatus: string | null } {
  if (ref.documentId !== undefined) {
    const row = db
      .prepare('SELECT id, work_id, content_status FROM document WHERE id = ?')
      .get(ref.documentId) as
      | { id: number; work_id: number; content_status: string }
      | undefined
    if (!row) return { documentId: null, workId: null, contentStatus: null }
    return { documentId: row.id, workId: row.work_id, contentStatus: row.content_status }
  }
  if (ref.workId === undefined) return { documentId: null, workId: null, contentStatus: null }
  const row = db
    .prepare(
      `SELECT id, content_status FROM document
        WHERE work_id = ?
        ORDER BY is_preferred DESC, id ASC
        LIMIT 1`
    )
    .get(ref.workId) as { id: number; content_status: string } | undefined
  if (!row) return { documentId: null, workId: ref.workId, contentStatus: null }
  return { documentId: row.id, workId: ref.workId, contentStatus: row.content_status }
}

/** The largest slice of a document one call will return. */
export const TEXT_PAGE_CHARS = 20_000
/** The most paragraphs one call will return, whatever their size. */
export const TEXT_PAGE_PARAGRAPHS = 400
/** The most hits one find will return. `total` counts a little past this, no further. */
export const FIND_MAX_HITS = 100
/** Characters of context carried either side of a hit. */
const FIND_CONTEXT = 120

/**
 * What a text read returns.
 *
 * An ALIAS of the contract DTO, not a copy: the IPC handler returns this value
 * verbatim, and two independently-maintained declarations of the same shape
 * would drift the first time a field moved.
 */
export type DocumentTextResult = DocumentTextDTO

/**
 * A range of a document's text.
 *
 * Paged by paragraph INDEX rather than by character offset: `idx` is what the
 * inventory numbers its paragraphs by, it is indexed, and it is the unit an
 * evidence span anchors to. A character-offset page would cut a paragraph in
 * half and hand back a quote that appears nowhere in the paper.
 */
export function getDocumentText(
  db: DB,
  ref: { workId?: number; documentId?: number; fromIdx?: number; toIdx?: number; page?: number }
): DocumentTextResult {
  const doc = resolveDocument(db, ref)
  const base = {
    document_id: doc.documentId,
    stage_run_id: null,
    content_status: doc.contentStatus,
    paragraphs: [] as ParagraphRow[],
    total_paragraphs: 0,
    truncated: false
  }
  if (doc.documentId === null) return { state: 'no-document', ...base }

  const run = currentTextRun(db, doc.documentId)
  if (run.state !== 'ok' || run.stageRunId === null) return { state: run.state, ...base }

  const where: string[] = ['stage_run_id = ?']
  const params: unknown[] = [run.stageRunId]
  if (ref.page !== undefined) {
    where.push('page = ?')
    params.push(ref.page)
  }
  if (ref.fromIdx !== undefined) {
    where.push('idx >= ?')
    params.push(ref.fromIdx)
  }
  if (ref.toIdx !== undefined) {
    where.push('idx <= ?')
    params.push(ref.toIdx)
  }
  const clause = where.join(' AND ')

  // TWO counts, because they answer different questions. `total` is what the
  // FILTER matched — the denominator for paging. `inventoryTotal` is what the
  // document holds at all, and it is the only one allowed to decide
  // `empty-text`: a page filter that matched nothing is a request for a page
  // that is not there, not a PDF that yielded no prose, and conflating them
  // would tell a reader their fully-extracted paper has no text.
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM document_paragraph WHERE ${clause}`)
      .get(...params) as { c: number }
  ).c
  const inventoryTotal =
    where.length === 1
      ? total
      : (
          db
            .prepare('SELECT COUNT(*) AS c FROM document_paragraph WHERE stage_run_id = ?')
            .get(run.stageRunId) as { c: number }
        ).c

  // One paragraph over the cap, so "there is more" is observed rather than
  // inferred from the row count happening to equal the limit.
  const rows = db
    .prepare(
      `SELECT para_id, idx, char_start, char_end, page, kind, section, text
         FROM document_paragraph
        WHERE ${clause}
        ORDER BY idx ASC
        LIMIT ?`
    )
    .all(...params, TEXT_PAGE_PARAGRAPHS + 1) as ParagraphRow[]

  let truncated = rows.length > TEXT_PAGE_PARAGRAPHS
  const out: ParagraphRow[] = []
  let chars = 0
  for (const r of rows.slice(0, TEXT_PAGE_PARAGRAPHS)) {
    if (chars > 0 && chars + r.text.length > TEXT_PAGE_CHARS) {
      truncated = true
      break
    }
    out.push(r)
    chars += r.text.length
  }

  if (inventoryTotal === 0) {
    return { state: 'empty-text', ...base, stage_run_id: run.stageRunId }
  }
  return {
    state: 'ok',
    document_id: doc.documentId,
    stage_run_id: run.stageRunId,
    content_status: doc.contentStatus,
    paragraphs: out,
    total_paragraphs: total,
    truncated
  }
}

/**
 * One literal match inside a paper. Aliased from the contract — this value
 * crosses IPC verbatim, so a second declaration could only ever drift from it.
 */
export type FindHit = TextHitDTO

/** What a find returns. Aliased from the contract, for the same reason. */
export type FindResult = TextSearchDTO

/** The longest needle accepted. Beyond this the caller means something else. */
export const FIND_MAX_NEEDLE = 512

/**
 * The longest run of ASCII characters in a needle, or null if there is none.
 *
 * What the SQL prefilter narrows on. ASCII is the exact domain where SQLite's
 * LIKE and a JavaScript `iu` regex agree about case, so a run of it is a
 * condition the regex's own match is guaranteed to satisfy — which is what makes
 * the filter safe to apply. Two characters minimum: a single letter selects
 * almost every paragraph, so the filter would cost a LIKE over the document and
 * remove nothing.
 */
function longestAsciiRun(needle: string): string | null {
  let best = ''
  let cur = ''
  for (const ch of needle) {
    if (ch.charCodeAt(0) < 128) {
      cur += ch
      if (cur.length > best.length) best = cur
    } else {
      cur = ''
    }
  }
  return best.length >= 2 ? best : null
}

/** Raised for a needle that is not a search. Distinct from "no matches". */
export class EmptyNeedleError extends Error {
  constructor() {
    super('Enter something to search for.')
    this.name = 'EmptyNeedleError'
  }
}

/**
 * LITERAL search inside one document.
 *
 * MATCHING is deliberately not folded. `foldForSearch` strips combining marks,
 * which is not length-preserving — offsets computed against a folded string do
 * not satisfy `text.slice(char_start,char_end) === paragraph.text`, the contract
 * the whole anchoring engine rests on and that `segment.ts` fails a run over. A
 * regex with the `i` flag case-folds during matching and reports indices into
 * the ORIGINAL string, so case-insensitivity comes free with the offsets intact.
 * Accent-insensitivity is the price, and it is the right one: an offset an agent
 * cannot cite is worth less than a match it has to spell correctly.
 *
 * The SQL prefilter narrows on the needle's longest ASCII run, which is the one
 * condition SQLite's LIKE and this regex are guaranteed to agree about. See the
 * comment at the query itself for why the two more obvious folds are both
 * unsafe.
 *
 * A needle is matched WITHIN one paragraph and never across two. The regex runs
 * per row, so a phrase straddling a paragraph break cannot be found — which is
 * the right behaviour (the break is real text structure, and an offset spanning
 * it would name a range that is not contiguous in any paragraph) but is not
 * something a caller would guess.
 *
 * References are NOT excluded. The summary excludes them because a model shown
 * a bibliography summarises the field; someone SEARCHING a paper is very often
 * looking for exactly a cited author or title, and this app's own rule is that
 * references are surfaced rather than silently dropped. Each hit carries its
 * `kind` and `section` so a caller can filter if it wants to.
 */
export function findInDocument(
  db: DB,
  ref: {
    workId?: number
    documentId?: number
    needle: string
    caseSensitive?: boolean
    limit?: number
    offset?: number
  }
): FindResult {
  const needle = ref.needle
  if (needle.trim().length === 0) throw new EmptyNeedleError()
  if (needle.length > FIND_MAX_NEEDLE) {
    throw new Error(`Search text is too long (${needle.length} characters; the limit is ${FIND_MAX_NEEDLE}).`)
  }

  const doc = resolveDocument(db, ref)
  const base = {
    document_id: doc.documentId,
    stage_run_id: null,
    content_status: doc.contentStatus,
    hits: [] as FindHit[],
    total: 0,
    truncated: false
  }
  if (doc.documentId === null) return { state: 'no-document', ...base }

  const run = currentTextRun(db, doc.documentId)
  if (run.state !== 'ok' || run.stageRunId === null) return { state: run.state, ...base }

  const limit = Math.min(Math.max(1, ref.limit ?? FIND_MAX_HITS), FIND_MAX_HITS)
  const offset = Math.max(0, ref.offset ?? 0)

  // `u` as well as `i`: without it a surrogate pair in the needle is treated as
  // two independent code units and an emoji or a rare CJK character matches
  // halves of unrelated pairs.
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ref.caseSensitive ? 'gu' : 'giu')

  // Narrowed in SQL first so a long document does not stream every paragraph
  // into JS to be rejected. The prefilter MUST be wider than the regex, or it
  // silently decides the search — and getting that right is subtler than it
  // looks, because SQLite's LIKE folds ASCII case only.
  //
  // Two folds that both seemed safe are NOT. Plain `LIKE` on the raw needle
  // misses `ähnlich` for `Ähnlich`, because LIKE will not case-fold a non-ASCII
  // letter. And `search_fold` on both sides — the obvious repair — is wider on
  // the ACCENT axis while being NARROWER on the case axis: it is NFD +
  // strip-marks + lowercase, not Unicode case folding, so it leaves µ (MICRO
  // SIGN) and μ (GREEK MU) distinct where the regex's `iu` flags treat them as
  // the same character. In an enzyme-kinetics corpus, where a keyboard emits one
  // and a PDF's text layer the other, that is the most-typed needle there is.
  // Eighty-three such pairs exist below U+3000 — final sigma, the Greek symbol
  // variants, the long s.
  //
  // So the prefilter narrows on the LONGEST RUN OF ASCII in the needle, and on
  // nothing at all when there is none. An ASCII run is the one thing LIKE and
  // the regex are guaranteed to agree about, so any paragraph the regex could
  // match must contain that run and must survive the filter. It is a filter, not
  // an answer: the regex still decides every hit.
  const asciiRun = longestAsciiRun(needle)
  const rows = (
    asciiRun === null
      ? db
          .prepare(
            `SELECT para_id, idx, char_start, char_end, page, kind, section, text
               FROM document_paragraph
              WHERE stage_run_id = ?
              ORDER BY idx ASC`
          )
          .all(run.stageRunId)
      : db
          .prepare(
            `SELECT para_id, idx, char_start, char_end, page, kind, section, text
               FROM document_paragraph
              WHERE stage_run_id = ? AND text LIKE ? ESCAPE '\\'
              ORDER BY idx ASC`
          )
          .all(run.stageRunId, `%${asciiRun.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
  ) as ParagraphRow[]

  // COUNTING STOPS. Better-sqlite3 is synchronous and this loop runs on the
  // main thread, so an exact `total` for a needle like "the" in a 500-page paper
  // means tens of thousands of regex executions between one IPC message and the
  // next — the window stops repainting to compute a number nobody reads past
  // the first page of. Counting one match beyond what could be returned is
  // enough to answer "is there more", which is the only thing `total` is for
  // here, and `truncated` says the count is a floor rather than a total.
  const countCeiling = offset + limit + 1
  const hits: FindHit[] = []
  let total = 0
  let exhausted = true
  outer: for (const p of rows) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(p.text)) !== null) {
      // A zero-length match cannot happen with a non-empty literal needle, but
      // an unadvanced lastIndex would spin forever if one ever did.
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (total >= countCeiling) {
        exhausted = false
        break outer
      }
      const idx = total
      total++
      if (idx < offset || hits.length >= limit) continue
      hits.push({
        para_id: p.para_id,
        idx: p.idx,
        page: p.page,
        kind: p.kind,
        section: p.section,
        char_start: p.char_start + m.index,
        char_end: p.char_start + m.index + m[0].length,
        quote: m[0],
        before: p.text.slice(Math.max(0, m.index - FIND_CONTEXT), m.index),
        after: p.text.slice(m.index + m[0].length, m.index + m[0].length + FIND_CONTEXT)
      })
    }
  }

  return {
    state: 'ok',
    document_id: doc.documentId,
    stage_run_id: run.stageRunId,
    content_status: doc.contentStatus,
    hits,
    total,
    // True when matches remain beyond this page, whether because the count
    // ceiling was reached or because the page simply did not reach the end.
    truncated: !exhausted || total > offset + hits.length
  }
}
