// The words this app uses for its own enums, written for a READER.
//
// The database stores short keys — `primary`, `directly-reported`, `unclear` —
// which are the right thing in a column and the wrong thing in a note. Exported
// to Zotero or a vault, a line reading "Role: primary" is a term of art with no
// definition attached, landing in a library where nothing explains it, possibly
// read months later by someone who never used this app.
//
// So every enum has a phrase here. SHARED between the markdown notes, the Zotero
// export and the tags, so a term cannot mean one thing in a note and another in
// a tag; and kept beside the schema's CHECK constraints, so adding a value to
// one is a visible omission in the other.

/** A phrase for a stored key, plus the tag it becomes in Zotero. */
export interface Term {
  /** Sentence-case, a few words, complete on its own. */
  label: string
  /** Short, lowercase, prefixed — Zotero's tag selector is a flat list. */
  tag: string
}

const unknownTerm = (raw: string): Term => ({ label: raw, tag: raw })

/** Where the paper stands in the reading workflow (`project_work.inclusion_status`). */
export const INCLUSION_STATUS: Record<string, Term> = {
  included: { label: 'Included in the project', tag: 'status: included' },
  excluded: { label: 'Excluded after assessment', tag: 'status: excluded' },
  read: { label: 'Read, not yet decided', tag: 'status: read' },
  unread: { label: 'Not yet read', tag: 'status: unread' },
  uncertain: { label: 'Undecided — needs a closer look', tag: 'status: undecided' }
}

/**
 * WHERE a claim came from — the epistemic status of an extracted value.
 *
 * The most important vocabulary in the app: it separates what a paper actually
 * said from what was worked out on its behalf, and a reader who cannot tell
 * those apart has been misled about their own data.
 */
export const FACT_KIND: Record<string, Term> = {
  'directly-reported': {
    label: 'Stated directly in the paper',
    tag: 'claim: stated in paper'
  },
  inferred: {
    label: 'Inferred from what the paper reports',
    tag: 'claim: inferred'
  },
  'supplied-by-project-context': {
    label: 'Supplied by this project, not the paper',
    tag: 'claim: from project context'
  },
  'uncertain-conflicting': {
    label: 'Uncertain — the paper is unclear or self-conflicting',
    tag: 'claim: uncertain'
  }
}

/** Whether an automated check agreed with the extraction (`analysis_run.verifier_result`). */
export const VERIFIER_RESULT: Record<string, Term> = {
  passed: { label: 'Automated checks passed', tag: 'checks: passed' },
  partial: { label: 'Some automated checks did not pass', tag: 'checks: partial' },
  failed: { label: 'Automated checks failed — verify before use', tag: 'checks: failed' },
  'not-run': { label: 'Automated checks were not run', tag: 'checks: not run' }
}

/** How safely a fold-improvement can be compared (`fold_improvement.comparability`). */
export const COMPARABILITY: Record<string, Term> = {
  directly: { label: 'Directly comparable — same assay conditions', tag: 'fold: directly' },
  broadly: { label: 'Broadly comparable — similar conditions', tag: 'fold: broadly' },
  contextual: { label: 'Comparable only in context', tag: 'fold: contextual' },
  unclear: { label: 'Not safely comparable — conditions unclear', tag: 'fold: unclear' }
}

/** How much of the paper was available to read (`document.content_status`). */
export const CONTENT_STATUS: Record<string, Term> = {
  fulltext: { label: 'Full text was available', tag: 'source: full text' },
  'abstract-only': {
    label: 'Abstract only — no full text was read',
    tag: 'source: abstract only'
  },
  'metadata-only': { label: 'Metadata only — the paper was not read', tag: 'source: metadata only' },
  unknown: { label: 'Availability unknown', tag: 'source: unknown' }
}

/** Look a key up, falling back to the raw value rather than dropping it. */
export function term(vocab: Record<string, Term>, key: string | null | undefined): Term | null {
  if (!key) return null
  // An unrecognised value is shown VERBATIM: a stored key we have no phrase for
  // is still a fact about the data, and silently omitting it would hide it.
  return vocab[key] ?? unknownTerm(key)
}

/** The reader-facing phrase for a key, or null. */
export function label(vocab: Record<string, Term>, key: string | null | undefined): string | null {
  return term(vocab, key)?.label ?? null
}
