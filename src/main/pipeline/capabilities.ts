// The payload SHAPE behind each capability token.
//
// These live here rather than in the stage that emits them because a consumer
// importing `type { DocumentFile } from './download'` recreates exactly the
// stage-to-stage coupling capability tokens exist to remove: the token is
// supposed to name a shape, so the shape must not be owned by one producer. A
// transformer that rewrites `text.pages@v2` is a second producer of the same
// type, and neither producer should have to import the other.
//
// A token's version suffix and its interface here change TOGETHER. Widening a
// shape without bumping the token is the failure the registry cannot catch: it
// validates that a token is provided, not that the value matches what a
// consumer expected.

/** `document.file@v1` — where a document's bytes are, and what they are. */
export interface DocumentFile {
  documentId: number
  baseDir: string
  relativePath: string
  absPath: string
  sizeBytes: number
  sha256: string
}

/**
 * A positioned text run, with its span in the CANONICAL document text.
 *
 * Carried because 18 of this corpus's 20 papers cite by SUPERSCRIPT rather than
 * by `[17]`, and a superscript is invisible in a plain string: `...esterase17.`
 * and `...esterase 17.` are indistinguishable from the characters alone.
 * Detecting one needs the glyph height and the baseline, and knowing WHICH
 * characters were raised needs the span — re-finding the substring would match
 * the wrong occurrence.
 */
export interface TextItem {
  str: string
  charStart: number
  charEnd: number
  height: number
  baseline: number
  /** Left edge in PDF user space. Absent on pages recovered by OCR. */
  x?: number
  /** Advance width in PDF user space. Absent on pages recovered by OCR. */
  width?: number
}

export interface TextPage {
  page: number
  charStart: number
  charEnd: number
  text: string
  /** Absent when the producer had no geometry (e.g. an OCR transformer). */
  items?: TextItem[]
}

/**
 * `text.pages@v2` — the per-page text layer plus the canonical joined string
 * every downstream offset indexes into.
 *
 * `text.slice(page.charStart, page.charEnd) === page.text` for every page, by
 * construction. Downstream anchoring is built on that holding exactly.
 */
export interface TextPages {
  documentId: number
  pageCount: number
  text: string
  pages: TextPage[]
  /** Which stage produced these characters. `ocr` rewrites this to 'ocr'. */
  source: 'pdf-text-layer' | 'ocr'
}

/**
 * One recognised word, with its box on the RASTER and its span in the text.
 *
 * `charStart`/`charEnd` index the CANONICAL document string — the same offsets
 * every other anchor uses — so a word box can be found from a text position and
 * vice versa without re-searching for a substring that may occur many times.
 *
 * The box is in raster pixels, `y` DOWNWARDS from the top row, which is the
 * space tesseract reports in. It is deliberately not pre-converted to page
 * coordinates: the conversion needs the page's own placement matrix, which is
 * stored once per page rather than baked into a thousand boxes, and a stored
 * approximation could not be re-derived if the mapping were ever corrected.
 */
export interface OcrWord {
  charStart: number
  charEnd: number
  /**
   * The characters this box covers.
   *
   * Carried rather than re-sliced from the canonical text by the reader, so the
   * geometry is self-contained: the viewer would otherwise have to fetch the
   * whole document string over IPC purely to label boxes it already has, and any
   * drift between the two would silently mislabel every word after it.
   */
  text: string
  /**
   * The exact characters separating this word from the next, from the canonical
   * text.
   *
   * Carried because a text layer is COPIED, not only searched. Absolutely
   * positioned word spans have no whitespace between them, so a selection over
   * spans alone yields `Thereactionshownin…` — the layer looks right on screen
   * and produces unusable text on the clipboard. Taking the separator from the
   * canonical string rather than reconstructing it means a copy reproduces the
   * document's own line breaks instead of a guess about them.
   */
  gap: string
  x0: number
  y0: number
  x1: number
  y1: number
  /** Tesseract's per-word confidence, 0–100. */
  confidence: number
}

/** The geometry of one OCR'd page, and where its raster sits on the page. */
export interface OcrPageGeometry {
  page: number
  /** The raster OCR actually ran on, in pixels. Boxes index into this. */
  rasterWidth: number
  rasterHeight: number
  /**
   * The PDF transform that maps the raster's UNIT SQUARE onto page user space,
   * `[a, b, c, d, e, f]`.
   *
   * A raster pixel `(px, py)` sits at `u = px/rasterWidth`,
   * `v = 1 - py/rasterHeight`, then `(a·u + c·v + e, b·u + d·v + f)`.
   *
   * Stored rather than assumed because the scan is NOT flush with the page: on
   * this corpus's scanned paper the image covers user-space x ∈ [0, 586],
   * y ∈ [0, 804] while the crop box is 581.1 wide and begins at y = 10.29.
   * Treating the raster as if it filled the rendered page box puts every word
   * several pixels off its glyphs, and further out the more the reader zooms.
   */
  placement: [number, number, number, number, number, number]
  words: OcrWord[]
}

/**
 * `text.wordboxes@v1` — where each OCR'd word physically SITS.
 *
 * Separate from `text.pages@v2` rather than a field on it, because only the OCR
 * producer can ever fill it and the two are read by different consumers at
 * different times: every downstream stage wants the text, and only the viewer
 * wants the geometry. It is emphatically NOT `TextPage.items`, which carries
 * glyph baselines that the superscript-callout detector reads — OCR has no
 * baselines worth that name, and inventing them would corrupt the citation
 * scan, which is exactly why that field is documented as absent here.
 */
export interface WordBoxes {
  documentId: number
  /**
   * Mean character confidence of the run that produced these boxes, 0–100.
   *
   * Travels WITH the geometry so a consumer cannot present recognised words as
   * publisher text without having been told how well they were read.
   */
  meanConfidence: number
  pages: OcrPageGeometry[]
}

/**
 * `text.embeddings@v1` — what was embedded, and INTO WHICH SPACE.
 *
 * The space id is the load-bearing field. A cosine between vectors from two
 * different spaces is a number rather than an error, so anything reading this
 * has to be able to check which space answered before comparing anything.
 *
 * The vectors themselves are deliberately NOT here: they live in `chunk` plus
 * the space's `vec0` table, and a whole document's worth would have to cross
 * the host boundary a second time as an artifact for no reader at all.
 */
export interface Embeddings {
  documentId: number
  spaceId: number
  /** The space's derived identity. A change here invalidates every vector. */
  configHash: string
  dims: number
  chunkCount: number
}

/** IMRaD buckets. Closed, lowercase, hyphenated — normalised at segment time. */
export type SectionBucket =
  | 'title'
  | 'abstract'
  | 'introduction'
  | 'background'
  | 'related-work'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'acknowledgements'
  | 'references'
  | 'supplementary'
  | 'other'

export type ParagraphKind = 'prose' | 'heading' | 'list' | 'caption' | 'reference' | 'table_row'

export interface ParagraphRecord {
  /** Positional: `p0`, `p1`, … A re-segment renumbers these. */
  paraId: string
  index: number
  charStart: number
  charEnd: number
  page: number | null
  kind: ParagraphKind
  section: SectionBucket
  text: string
}

/** `text.paragraphs@v1` — the paragraph inventory every anchor resolves against. */
export interface Paragraphs {
  documentId: number
  /** The same canonical string `text.pages@v2` published; offsets index into it. */
  text: string
  paragraphs: ParagraphRecord[]
}

/**
 * One bibliography entry as the parser saw it, with the ordinal preserved.
 *
 * `refs.entries@v1` exists because a reference that RESOLVES loses its ordinal:
 * `unresolved_reference` is deleted on resolution and `citation_edge` has no
 * ordinal column and cannot have one (edges are deduped per work pair, and two
 * bibliography entries may name the same paper). Without this artifact, stage 7
 * could not map the callout `[17]` to an edge for exactly the references that
 * did resolve — the successful ones.
 */
export interface ReferenceEntry {
  ordinal: number
  rawBibText: string
  /** Set when the entry matched a work in the corpus. */
  citedWorkId: number | null
  /** Set when it did not, and a row is holding its text. */
  unresolvedReferenceId: number | null
  edgeId: number | null
  /**
   * The edge type this entry resolved through, when a later promotion made it
   * something other than the ordinary `cites`.
   *
   * Carried because the edge is re-selected by its natural key
   * (citing, cited, type) at write time rather than trusted from `edgeId`, and
   * a consumer that assumed `cites` would find no edge for an `extends` or
   * `refutes` resolve — then silently drop every callout of that entry.
   */
  edgeType?: string | null
  authors: string | null
  year: number | null
  title: string | null
  /**
   * Where this entry is PRINTED, in the canonical document offset space.
   *
   * `sectionCharStart`/`End` below describes a CONTIGUOUS bibliography, and that
   * is the shape a modern paper has. An older journal sets each reference at the
   * foot of the page that cites it, so the entries are scattered through the
   * body and no single range covers them without also covering the paper — which
   * is why the section range is disabled entirely for those documents, and why
   * their printed footnote lines were then scanned as body text and stored as
   * citing sentences. Per-entry spans describe both layouts.
   *
   * -1/-1 means "could not be located", which every consumer must read as no
   * region at all rather than as offset zero. Absent on an artifact written
   * before this existed, which reads the same way.
   */
  charStart?: number
  charEnd?: number
  /**
   * Which lettered part of a composite entry this is ('a', 'b', …), or null for
   * a whole printed entry.
   *
   * ACS and Angewandte print several papers under one number, and the parser
   * emits the composite AND one row per part so each can be resolved on its
   * own — all sharing the parent's `ordinal`. So `entries.length` is NOT the
   * number of references the paper printed, and anything that treats it that
   * way overstates the bibliography by however many sub-references it holds.
   * `referenceCount` below is the printed figure; this field is what lets a
   * consumer of `entries` recover it.
   *
   * Absent on an artifact written before this existed. Absent is not `null`
   * here in meaning: it says the parse could not distinguish the two, whereas
   * null says it looked and this is a whole entry.
   */
  partLabel?: string | null
}

/** `refs.parsed@v1` — the parse outcome plus every entry, ordinals intact. */
export interface ParsedReferences {
  workId: number
  documentId: number | null
  parserVersion: string
  /**
   * How many references the paper PRINTED — NOT `entries.length`.
   *
   * The two differ for any bibliography with lettered sub-references; see
   * `ReferenceEntry.partLabel`. This is the number to show a reader and the
   * number to divide by.
   */
  referenceCount: number
  matchedCount: number
  /** Every parsed row, composites and their parts alike. */
  entries: ReferenceEntry[]
  /**
   * The bibliography's own span in the canonical text, or -1/-1 when the parser
   * found no section.
   *
   * Carried because every entry in a numbered reference list literally begins
   * `[17]`: a callout scan that did not exclude this range would find one fake
   * callout per entry, and those fakes would then SATISFY the confidence gate
   * that exists to catch a mis-detected numbering scheme — turning the guard
   * into a rubber stamp.
   */
  sectionCharStart: number
  sectionCharEnd: number
  /** How entries were numbered. `author-year` cannot be linked to callouts. */
  entryStyle: string
  /**
   * In-text citation sites the FILE ITSELF recorded, as char offsets.
   *
   * A link annotation's rectangle is where the typesetter PRINTED the marker,
   * so this is a measurement rather than the result of finding a digit in a
   * sentence — the scan that also matches `1 Department of Biochemistry` and
   * `15,800 M 2 1 cm 2 1`. Where it is present it is the better answer, and it
   * is present on a quarter of this corpus: 619 sites across five Elsevier and
   * Springer papers, on all of which the text scan finds roughly a third as
   * many.
   *
   * `key` IS NOT AN ORDINAL and must never be read as one. It is the file's own
   * name for a destination, and what the digits in it mean is the publisher's
   * business: `bib12` really is entry 12, but Elsevier's `bb0025` is the FIFTH
   * entry — a stride of five — and its trailing number agreed with the printed
   * marker on 0 of 139 links measured here. Sorting the keys and taking their
   * rank is no better. What identifies the entry is the text inside the
   * rectangle, which is the marker the reader sees; the key is only useful for
   * telling two sites apart.
   *
   * Empty for a file that records none, which is most of them. Absent on an
   * artifact written before this existed, which means the same thing.
   */
  nativeCallouts?: Array<{ key: string; charStart: number; charEnd: number; page: number }>
}

/**
 * `refs.abstracts@v1` — a COUNT of what was looked up, never the abstracts.
 *
 * The text itself lives in `reference_abstract`, keyed on `citing_work_id` so it
 * survives a reference being promoted to a real work. Carrying it here as well
 * would put a second copy of every paragraph in an artifact blob, ageing
 * separately from the row a re-fetch replaces — and a reader holding two answers
 * has none. What the artifact is for is the question a dependent actually asks:
 * has this bibliography been looked up, under which gate, and how far it got.
 */
export interface ReferenceAbstracts {
  citingWorkId: number
  /**
   * The strictness the rows were admitted under. A dependent comparing two
   * papers' coverage must read it: rows written under an older gate were
   * accepted on evidence this build would refuse.
   */
  fetcherVersion: number
  /** Unmatched whole entries a row was written for, refusals included. */
  asked: number
  withAbstract: number
}

/**
 * `project.ranking@v1` — that every project's papers have been ranked, and how
 * far the relevance half got.
 *
 * COUNTS, never the scores. The numbers live in `project_work`, where the user
 * can override one and where every screen reads them; a copy in an artifact
 * would age separately from the row a re-rank replaces, and a reader holding two
 * answers has none. `scored` is deliberately reported apart from `works`,
 * because they differ for reasons a reader must be able to tell apart: no
 * reranker packaged, or a project that has not written down what it is asking.
 */
export interface ProjectRanking {
  projects: number[]
  works: number
  /** Papers a model actually scored. Fewer than `works` is not a failure. */
  scored: number
}
