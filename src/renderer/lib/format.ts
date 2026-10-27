// Small presentational helpers shared across screens. No data lives here.

export const fmtScore = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v.toFixed(2)

export const fmtYear = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : String(v)

export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

// Human-readable byte size (base-1000, matching the design's "4.8 GB" style).
export const fmtBytes = (n: number | null | undefined): string => {
  if (n === null || n === undefined || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0)
  return `${s} ${units[i]}`
}

// content_status → human label + severity class
export const contentStatusMeta = (
  s: string | null | undefined
): { label: string; cls: string } => {
  switch (s) {
    case 'fulltext':
      return { label: 'full text', cls: 'ok' }
    case 'abstract-only':
    case 'abstract_only':
      return { label: 'abstract only', cls: 'warn' }
    case 'metadata-only':
    case 'metadata_only':
      return { label: 'metadata only', cls: 'danger' }
    default:
      return { label: s ?? 'unknown', cls: 'muted' }
  }
}

/**
 * How much of the PAPER an analysis of this document actually stood on.
 *
 * DERIVED FROM BOTH COLUMNS, never from either alone, and never written back.
 * `content_status` is what `extract-text` MEASURED — characters were found, and
 * plenty of them — so it says `fulltext` of a supplementary-materials PDF just
 * as readily as of the article. What that measurement cannot know is which
 * document it measured; `version_kind` is where the model that READ the file
 * records that, and the two are only honest together.
 *
 * Overwriting the stored `content_status` would have been the shorter fix and
 * is the wrong one: it destroys an observation to express a conclusion drawn
 * later, and a re-extraction would then quietly restore the overstatement.
 *
 * `full` is what every caller gates its badge on, so the exception speaks and
 * the ordinary case stays silent (hard rule 0.6). `null` is strictly "no
 * document was resolved", which is not a shortfall to warn about — a read that
 * found nothing is not a claim that the reading was thin.
 */
export const evidenceBasis = (
  doc: { content_status: string | null; version_kind: string | null } | null | undefined
): { label: string; cls: string; full: boolean } | null => {
  if (doc === null || doc === undefined) return null
  // A supplement is not the paper, however completely it was read, so it
  // outranks whatever the character count concluded.
  if (doc.version_kind === 'supplementary')
    return { label: 'supplementary material only', cls: 'danger', full: false }
  const meta = contentStatusMeta(doc.content_status)
  return { ...meta, full: doc.content_status === 'fulltext' }
}

/**
 * How a document's text was obtained → label, severity and the sentence a
 * reader needs to weigh a number lifted out of that text.
 *
 * A SECOND axis beside `contentStatusMeta`, never folded into it: that one says
 * how MUCH of the paper we have, this says how RELIABLY we read it. An OCR'd
 * scan is the full text at (say) 88 % character confidence — treating that as
 * equivalent to a publisher's embedded text layer is precisely the overstatement
 * the content-status badge already exists to prevent.
 *
 * Returns null for the publisher's own text layer, which is the norm and needs
 * no mark; a badge on every document trains the reader to skip the row where a
 * qualified source finally appears. Only the QUALIFIED cases are labelled.
 *
 * `unknown` is one of those: it means no run currently claims how the text was
 * obtained (or the claim was retracted with its run), and it is shown as such
 * rather than rounded up to the trusted case, which would assert something no
 * run stands behind.
 *
 * Deliberately NOT colour-alone: `ok`/`warn`/`danger`/`muted` each carry a
 * distinct WORD, and the OCR variants differ in text as well as tone, so the
 * distinction survives a colourblind reader.
 */
export const textSourceMeta = (
  source: string | null | undefined,
  confidence: number | null | undefined,
  lowThreshold: number
): { label: string; cls: string; hint: string } | null => {
  switch (source) {
    // The publisher's own characters are the unremarkable case, so it carries no
    // badge: a mark on every document is noise the reader learns to skip, and it
    // is the QUALIFIED sources below that have to catch the eye.
    case 'pdf-text-layer':
      return null
    case 'ocr': {
      const poor = confidence !== null && confidence !== undefined && confidence < lowThreshold
      const measured =
        confidence === null || confidence === undefined
          ? 'No mean confidence was recorded for the run.'
          : `Mean character confidence was ${confidence.toFixed(1)}%.`
      return {
        label: poor ? 'OCR · poorly read' : 'OCR',
        cls: poor ? 'danger' : 'warn',
        hint:
          'This PDF carried no text layer, so the characters were recognised from the page images. ' +
          `${measured} Recognition errors read as plausible text — check any number against the page before relying on it.`
      }
    }
    // `unknown` says nothing, because it is not a finding about the PAPER.
    //
    // It means no completed stage has claimed how the text was obtained yet —
    // which is true of every paper that has not been through extraction, so it
    // badged the whole queue the moment a corpus was planned. A pill on twenty
    // rows out of twenty is read as decoration, and it takes the OCR warning
    // beside it down too (HARD RULE 0.6). The queue's own row already says how
    // far a paper has got.
    case 'unknown':
      return null
    default:
      // Nothing to say rather than a made-up badge: a document that was never
      // through text extraction has no text-source claim to report.
      return null
  }
}

// inclusion_status → label + class
export const inclusionMeta = (
  s: string | null | undefined
): { label: string; cls: string } => {
  switch (s) {
    case 'included':
      return { label: 'included', cls: 'ok' }
    case 'excluded':
      return { label: 'excluded', cls: 'danger' }
    case 'uncertain':
      return { label: 'uncertain', cls: 'warn' }
    case 'read':
      return { label: 'read', cls: 'muted' }
    case 'unread':
      return { label: 'unread', cls: 'muted' }
    default:
      return { label: s ?? 'unread', cls: 'muted' }
  }
}

// The 5 fact kinds. These keys MUST match the `fact.kind` CHECK constraint in
// src/main/db/schema.ts verbatim — they are the stored values, not display
// names. A key that does not match falls through to the grey `muted` fallback,
// which would make an INFERRED claim look identical to a reported one and
// defeat the whole taxonomy.
//
// `hint` is the definition a reader needs in order to weigh the claim. It lives
// HERE, beside the label, so the wording cannot drift from the thing it
// explains — which is what a standalone legend elsewhere in the UI would do.
export const FACT_KINDS: { key: string; label: string; cls: string; hint: string }[] = [
  {
    key: 'directly-reported',
    label: 'directly reported',
    cls: 'ok',
    hint: 'Stated outright by the paper. The strongest kind of claim.'
  },
  {
    key: 'inferred',
    label: 'inferred',
    cls: 'accent',
    hint: 'Derived by the model from what the paper says — not stated as such. Check the evidence before relying on it.'
  },
  {
    key: 'supplied-by-project-context',
    label: 'from project context',
    cls: 'muted',
    hint: 'Came from this project\u2019s context, not from this paper. Background, not a finding of this work.'
  },
  {
    key: 'uncertain-conflicting',
    label: 'uncertain / conflicting',
    cls: 'danger',
    hint: 'The source is ambiguous, or disagrees with itself or another source. Needs a human decision.'
  }
]

export const factKindMeta = (
  k: string | null | undefined
): { label: string; cls: string; hint: string } => {
  const hit = FACT_KINDS.find((f) => f.key === k)
  return (
    hit ?? {
      label: k ?? 'unknown',
      cls: 'muted',
      // An unrecognised kind is a real state (the model returned something the
      // enum does not cover); saying so beats an empty tooltip.
      hint: 'This kind is not one the app recognises, so its reliability cannot be judged.'
    }
  )
}

// fold comparability → 4-class
export const comparabilityMeta = (
  c: string | null | undefined
): { label: string; cls: string } => {
  switch (c) {
    case 'directly':
      return { label: 'directly comparable', cls: 'ok' }
    case 'broadly':
      return { label: 'broadly comparable', cls: 'accent' }
    case 'contextual':
      return { label: 'contextual', cls: 'warn' }
    case 'unclear':
      return { label: 'unclear', cls: 'danger' }
    default:
      return { label: c ?? 'unclear', cls: 'muted' }
  }
}

/**
 * What to DRAW for a paper's expansion priority.
 *
 * ONE helper, shared by the Ranking list, its scatter and the Connectome's
 * frontier map, because those three read the same column and disagreeing about
 * it would put a paper in the top third of one and the bottom of another.
 *
 * The RANK is preferred and the raw priority is the fallback. Expansion
 * priorities are heavily right-skewed — a real 20-paper project spans 0.0007 to
 * 0.1231 with half the field under 0.02 — so drawing the raw value renders as a
 * clump against the left edge and prints "EXP 0" on six of twenty papers that
 * were all scored perfectly well. The rank spreads the same ORDER across the
 * whole axis.
 *
 * The fallback matters and is not cosmetic: a row scored by a build older than
 * the rank column has a priority and no rank, and drawing nothing for it would
 * hide a paper that has in fact been measured. It reappears at its true rank
 * the next time the sweep runs.
 *
 * NEVER use this for arithmetic. A rank is an ordering — the distance between
 * two of them is not the distance between the papers, and it shifts when a
 * neighbour is added. Anything comparing magnitudes reads `expansion_priority`.
 */
export const expansionForDisplay = (row: {
  expansion_priority: number | null
  expansion_rank?: number | null
}): number | null => row.expansion_rank ?? row.expansion_priority

/**
 * What to DRAW for a paper's relevance.
 *
 * The twin of `expansionForDisplay`, and it exists for a sharper version of the
 * same problem. Relevances are ordinal sigmoids off a cross-encoder: measured
 * across 678 scored rows of this corpus they span 0.00004 to 0.98 with a MEDIAN
 * of 0.00044, so `Math.round(v * 10)` printed "0" against nearly every paper and
 * drew nearly every bar at zero width — a library of well-scored papers
 * reporting that none of it was relevant. The rank spreads the same ORDER over
 * the whole axis.
 *
 * The raw value is the fallback, and is not cosmetic: a row scored by a build
 * older than the rank column has a relevance and no rank, and drawing nothing
 * for it would hide a paper that HAS been measured. It takes its true rank the
 * next time the sweep runs.
 *
 * NULL SURVIVES. A paper nothing has scored returns null and must render as an
 * absence — never as a low score, which is a verdict no model reached.
 *
 * NEVER use this for arithmetic, for sorting, for a threshold, or in the "why
 * this rank" sentence. A rank is an ordering: the distance between two of them
 * is not the distance between the papers, and it shifts when a neighbour is
 * added. Anything comparing magnitudes reads `relevance`.
 */
export const relevanceForDisplay = (row: {
  relevance: number | null
  relevance_rank?: number | null
}): number | null => row.relevance_rank ?? row.relevance
