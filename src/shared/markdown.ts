// The markdown an Obsidian note is made of.
//
// SHARED between main (which writes the file) and the renderer (which previews
// it). That is deliberate and load-bearing: a preview computed by different code
// than the writer is a promise the app may not keep, and this screen used to
// show exactly such a preview beside a button that wrote nothing at all. One
// function means the block on screen IS the file on disk, byte for byte.
//
// PURE: no filesystem, no database, no Electron. It takes plain data and returns
// a string, which is also what makes it testable without a vault.

import { FACT_KIND, INCLUSION_STATUS, label } from './vocabulary'

/** The subset of a work a note describes. */
export interface NoteWork {
  id: number
  title: string
  venue: string | null
  publication_year: number | null
  doi: string | null
  authors: string[]
  abstract: string | null
  /**
   * Absolute path of this paper's PDF, when one is on this machine.
   *
   * Unused by the markdown renderer — a note links to the paper, not to a file
   * path that would break the moment the library moved. It rides along because
   * the Zotero RDF export, which shares this input, attaches the real file so an
   * import brings the PDFs across rather than metadata alone.
   */
  pdfPath?: string | null
}

/** One extracted claim, already resolved to display strings. */
export interface NoteFact {
  label: string
  value: string
  unit: string | null
  kind: string
  evidence: string | null
  /**
   * Why a reading WITHDREW this record, when one did (migration v52).
   *
   * The value itself is still here and still rendered. An export never filters
   * extracted data, so a note that dropped a withdrawn row would leave a vault
   * quietly different from the corpus it was written from — and the reader would
   * have no way to know a judgement had been made at all. `null` on all but a
   * handful of records, which is why it renders as an EXCEPTION rather than a
   * column of blanks.
   */
  retraction?: string | null
}

/** Everything one note needs. */
export interface NoteInput {
  work: NoteWork
  projectName: string
  relevance: number | null
  expansionPriority: number | null
  /**
   * The two scores' POSITIONS in their project's order, 1 highest, or null when
   * the score beside them is.
   *
   * Exported because the raw scores cannot be read. They are ordinal sigmoids
   * off a cross-encoder and heavily right-skewed — a real project's median
   * relevance rounds to 0 out of 10 — so `round(raw * 10)` wrote "relevance: 0"
   * into a user's vault for almost every paper it had scored perfectly well.
   *
   * The RAW values are still exported beside these, unrounded. Nothing is
   * filtered or replaced: a reader gets the measurement and its position, and
   * can tell which is which.
   */
  relevanceRank: number | null
  expansionRank: number | null
  inclusionStatus: string | null
  facts: NoteFact[]
  /** Titles of works this one cites, for [[wiki links]]. */
  cites: string[]
  /**
   * The same citations as `{id, doi}`, for consumers that need item IDENTITY
   * rather than a display title — Zotero's Related pane, which links by the
   * `rdf:about` an item is published under.
   */
  citeRefs?: Array<{ id: number; doi: string | null }>
  /** Model + timestamp of the analysis these facts came from. */
  provenance: { model: string | null; runAt: string | null } | null
}

export interface NoteOptions {
  backlinks: boolean
  /** The app name written into the frontmatter, so a note's origin is legible. */
  generator?: string
}

/** Render a 0..1 score on the 0..10 scale the UI uses. Null stays absent. */
function score10(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10)
}

/**
 * A filesystem-safe note filename (without extension).
 *
 * Obsidian note names double as link targets, so the characters that break a
 * wiki link (`[`, `]`, `|`, `#`, `^`) go along with the ones the filesystem
 * refuses. Truncated to 120 so a long title plus a path stays under the common
 * 255-byte filename limit.
 */
export function noteFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|[\]#^]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
    .replace(/[.\s-]+$/, '')
  return cleaned.length > 0 ? cleaned : 'Untitled'
}

/** Quote a YAML scalar only when it would otherwise be misread. */
function yaml(value: string): string {
  if (value === '') return "''"
  // A leading indicator character, a colon-space, or a trailing space all change
  // how YAML parses the line; quoting is the safe rendering for any of them.
  if (/^[-?:,[\]{}#&*!|>'"%@`]|: |\s$/.test(value) || /[\r\n]/.test(value)) {
    return `'${value.replaceAll("'", "''")}'`
  }
  return value
}

/**
 * Render one note.
 *
 * The frontmatter carries the machine-readable facts (scores, DOI, provenance)
 * because that is what Obsidian's Dataview and similar tools query; the body is
 * for a person. `corpus_work_id` is what makes a rewrite idempotent — it
 * identifies the note as this work's without depending on the filename, which a
 * user may rename.
 */
export function renderNote(input: NoteInput, options: NoteOptions): string {
  const { work } = input
  const gen = options.generator ?? 'Corpus Studio'
  const lines: string[] = []

  lines.push('---')
  lines.push(`title: ${yaml(work.title)}`)
  if (work.authors.length > 0) {
    lines.push('authors:')
    for (const a of work.authors) lines.push(`  - ${yaml(a)}`)
  }
  if (work.publication_year !== null) lines.push(`year: ${work.publication_year}`)
  if (work.venue) lines.push(`venue: ${yaml(work.venue)}`)
  if (work.doi) lines.push(`doi: ${yaml(work.doi)}`)
  lines.push(`project: ${yaml(input.projectName)}`)
  // The RANK for the x/10 figures, because the raw score does not survive the
  // rounding: a median relevance of ~0.0004 wrote `relevance: 0` on nearly
  // every note. The raw values follow, unrounded, so a Dataview query can still
  // reach the measurement itself.
  const rel = score10(input.relevanceRank ?? input.relevance)
  const exp = score10(input.expansionRank ?? input.expansionPriority)
  if (rel !== null) lines.push(`relevance: ${rel}`)
  if (exp !== null) lines.push(`expansion: ${exp}`)
  if (input.relevance !== null) lines.push(`relevance_score: ${input.relevance}`)
  if (input.expansionPriority !== null) lines.push(`expansion_score: ${input.expansionPriority}`)
  // Frontmatter keeps the RAW key: it is queried by Dataview and grouped on, so
  // it must be a stable identifier. The explanatory phrase goes in the body,
  // where a person reads it.
  if (input.inclusionStatus) lines.push(`status: ${yaml(input.inclusionStatus)}`)
  if (input.provenance?.model) lines.push(`analysed_by: ${yaml(input.provenance.model)}`)
  if (input.provenance?.runAt) lines.push(`analysed_at: ${yaml(input.provenance.runAt)}`)
  // The stable identity of this note, independent of its filename.
  lines.push(`corpus_work_id: ${work.id}`)
  lines.push(`generator: ${yaml(gen)}`)
  lines.push('---')
  lines.push('')

  lines.push(`# ${work.title}`)
  lines.push('')

  const meta = [
    work.authors.length > 0 ? work.authors.join(', ') : null,
    work.venue,
    work.publication_year !== null ? String(work.publication_year) : null
  ].filter((x): x is string => Boolean(x))
  if (meta.length > 0) {
    lines.push(`*${meta.join(' · ')}*`)
    lines.push('')
  }

  if (options.backlinks) {
    lines.push(`Project:: [[${input.projectName}]]`)
    lines.push('')
  }

  // What this paper is TO this project, in words. The raw key stays in the
  // frontmatter for querying; here it is explained, because "included" alone
  // is a term of art that arrives in the vault with nothing to define it.
  const standing = label(INCLUSION_STATUS, input.inclusionStatus)
  if (standing) {
    lines.push(`> ${standing}.`)
    lines.push('')
  }

  if (work.abstract) {
    lines.push('## Abstract')
    lines.push('')
    lines.push(work.abstract)
    lines.push('')
  }

  if (input.facts.length > 0) {
    // The "Withdrawn" column exists ONLY where something was withdrawn. HARD
    // RULE 0.6: a column that reads empty on every row of every note is a column
    // nobody reads, and it would take the one filled cell down with it.
    const anyRetracted = input.facts.some((f) => (f.retraction ?? '') !== '')
    lines.push('## Extracted')
    lines.push('')
    lines.push(anyRetracted ? '| Field | Value | Kind | Withdrawn |' : '| Field | Value | Kind |')
    lines.push(anyRetracted ? '| --- | --- | --- | --- |' : '| --- | --- | --- |')
    for (const f of input.facts) {
      const value = [f.value, f.unit].filter(Boolean).join(' ')
      // Pipes inside a cell would end it early and silently reshape the table.
      // The KIND is spelled out: "directly-reported" vs "assumed-from-field-
      // convention" is the difference between what the paper said and what was
      // filled in on its behalf, and a hyphenated key does not carry that to
      // someone reading the note a year later.
      //
      // A WITHDRAWN VALUE IS PRINTED, WITH THE READING THAT WITHDREW IT. Dropping
      // the row would make the vault disagree with the corpus and would hide a
      // judgement from the person it was made for; an export in this app never
      // filters what was extracted.
      const base = `| ${cell(f.label)} | ${cell(value)} | ${cell(label(FACT_KIND, f.kind) ?? f.kind)} |`
      lines.push(anyRetracted ? `${base} ${cell(f.retraction ?? '')} |` : base)
    }
    lines.push('')

    // WHO made these claims, in the body and not only in the frontmatter. A
    // table of numbers in someone's vault, months later, is indistinguishable
    // from something they read off the paper themselves unless it says
    // otherwise — and these are a model's readings, not the paper's own words.
    const by = [
      input.provenance?.model ? `by ${input.provenance.model}` : null,
      input.provenance?.runAt ? `on ${input.provenance.runAt.slice(0, 10)}` : null
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(
      `*Extracted from the full text ${by ? `${by} ` : ''}via ${gen}. Values are as reported by the paper; check them against the source before relying on them.*`
    )
    lines.push('')
  }

  if (options.backlinks && input.cites.length > 0) {
    lines.push('## Cites')
    lines.push('')
    for (const t of input.cites) lines.push(`- [[${noteFilename(t)}]]`)
    lines.push('')
  }

  // A single trailing newline: POSIX text convention, and it keeps a rewrite
  // from showing a spurious "no newline at end of file" diff in the user's vault
  // if it is under version control.
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

function cell(v: string): string {
  return v.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ')
}
