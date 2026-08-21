// Shared DTO types used across main <-> preload <-> renderer.
// Keep these plain/serializable (structured-clone safe).

/**
 * Whether a project has been set up yet.
 *
 * `onboarding` means the creation questionnaire is unfinished, and the shell
 * shows it INSTEAD of the project's own screens — which is why this rides on
 * `ProjectDTO` rather than being fetched separately: the dashboard has to know
 * where a card leads before the card is clicked.
 */
export type ProjectSetupState = 'onboarding' | 'done'

export interface ProjectDTO {
  id: number
  name: string
  slug: string
  /**
   * WHAT THIS COLLECTION IS FOR, as every prompt is given it.
   *
   * COMPOSED from `goal` and `questions` — it is not written directly any more,
   * and the two below are the form the user answers in. Kept as the one string
   * the model reads so that nothing downstream of it had to learn a new field.
   */
  description: string | null
  setup_state: ProjectSetupState
  /** The problematics this project pursues. Null on projects made before v55. */
  goal: string | null
  /**
   * The questions this project puts to its corpus, one per entry.
   *
   * A LIST, because the boundaries between them matter: the form renders a row
   * each and the model is handed them enumerated. Empty is the honest value for
   * a project that predates the questionnaire — not a missing answer, a
   * question never asked.
   */
  questions: string[]
  category: string | null // e.g. "Enzyme engineering" (design card subtitle)
  tags: string[] // module/tag pills, e.g. ["Enzyme kinetics"]
  created_at: string
  updated_at: string
  work_count: number // "papers" stat
  ranked_count: number // works with a computed/overridden relevance (design "ranked")
  /**
   * Papers this project's context is built from — what `DOSSIER_PAPER_LIMIT`
   * caps. Carried on the project rather than counted per screen: Ranking
   * paginates and the Paper screen holds one paper, so neither can see the
   * whole set it would have to count.
   */
  reference_paper_count: number
  extracted_count: number // works with >=1 extracted fact on a current run
  failed_count: number // failed processing jobs (design "N failed retrievals" pill)
  review_count: number // papers with a job parked awaiting a human decision
  unread_count: number // inclusion_status = 'unread'
  undecided_count: number // inclusion_status in ('read','uncertain')
  decided_count: number // inclusion_status in ('included','excluded')
  /**
   * Papers still moving through the pipeline right now — running, queued or
   * blocked on an upstream stage.
   *
   * Papers, not jobs: one paper carries a dozen stage jobs, so a job count
   * would exceed the corpus size and read as a broken counter. Present so that
   * several projects being processed at once can be watched from one screen.
   */
  processing_count: number
}

export interface WorkDTO {
  id: number
  title: string
  work_type: string
  publication_year: number | null
  venue: string | null
  abstract: string | null
  created_at: string
}

export interface AuthorDTO {
  id: number
  full_name: string
  position: number
  is_corresponding: number
  affiliation: string | null
}

export interface IdentifierDTO {
  id: number
  scheme: string
  value: string
}

export interface WorkDetailDTO extends WorkDTO {
  authors: AuthorDTO[]
  identifiers: IdentifierDTO[]
}

export interface ProjectWorkDTO {
  work: WorkDTO
  relevance: number
  expansion_priority: number
  /**
   * Each score's POSITION in its project's order, 1 highest, null when the
   * score beside it is. Display only — order, not distance, and it moves when a
   * neighbour is scored. Exported by the outlets because the raw sigmoids round
   * to 0 out of 10 for almost every paper.
   */
  relevance_rank: number | null
  expansion_rank: number | null
  inclusion_status: string
  ranking_explanation: string | null
  reviewed: number
}

/**
 * The citation-role vocabulary, mirroring the `citation_context.role` CHECK
 * constraint EXACTLY. The schema is the authority: it is shipped, seeded and
 * enforced, so a producer emitting anything else throws on insert.
 *
 * Kept here rather than inlined in the renderer so the classifier prompt, the
 * DAO and the UI all read one list, and widening it is a single edit next to
 * the migration that widens the CHECK.
 *
 * Note the near-misses to avoid: `method_used`, `supporting`, `contradictory`
 * and `review_reference` are NOT members — they are `method`, `support`,
 * `contrast` and `review`.
 */
export const CITATION_ROLES = [
  'background',
  'method',
  'comparison',
  'support',
  'contrast',
  'data-source',
  'motivation',
  'review',
  'other'
] as const
export type CitationRole = (typeof CITATION_ROLES)[number]

/** Human label for a role. Kept beside the vocabulary so they cannot drift. */
export const CITATION_ROLE_LABEL: Record<CitationRole, string> = {
  background: 'background',
  method: 'method used',
  comparison: 'compared with',
  support: 'supports',
  contrast: 'contradicts',
  'data-source': 'data source',
  motivation: 'motivation',
  // Read as "used as: …". The CITING paper is doing the pointing, so a label
  // like "reviewed by" would name the wrong side of the citation.
  review: 'points to a review',
  other: 'other'
}

export interface CitationEdgeDTO {
  id: number
  citing_work_id: number
  cited_work_id: number
  edge_type: string
  citing_title: string
  cited_title: string
  /**
   * Whether each endpoint has TEXT this install actually holds — `fulltext` or
   * `abstract-only` on its preferred document.
   *
   * Carried on the EDGE because an endpoint is often a paper the caller's own
   * project does not contain. A citation crosses project boundaries (a work is
   * stored once globally; only its interpretation is per-project), so a screen
   * that draws edges will meet works outside the pool it fetched and has
   * nothing to look them up in.
   *
   * It exists to keep "this project does not contain it" apart from "nothing
   * has been fetched for it". Those were conflated once, and a fully retrieved
   * paper that merely lived in another project was drawn as a dead end while
   * its PDF opened perfectly from the same panel.
   *
   * OPTIONAL, and absent means UNKNOWN, never false: an older main answering a
   * newer renderer omits it, and defaulting that to "no text" would restate the
   * same bug as a default.
   */
  citing_has_text?: boolean
  cited_has_text?: boolean
  /**
   * Who wrote each endpoint, and the first identifier it carries.
   *
   * On the EDGE for the same reason `has_text` is: an endpoint is frequently a
   * paper outside the caller's own project, and a screen drawing edges has
   * nothing to look one up in. A connectome node reached across a project
   * boundary was named by its title alone, while the identical paper selected
   * from inside its own project named its authors and its DOI.
   *
   * OPTIONAL, and absent means NOT ASKED, never "has none". An empty author
   * list and a null identifier are CLAIMS about the paper; an older main that
   * does not send these fields has made neither.
   */
  citing_authors?: string[]
  cited_authors?: string[]
  citing_identifier?: { scheme: string; value: string } | null
  cited_identifier?: { scheme: string; value: string } | null
  contexts: CitationContextDTO[]
}

export interface CitationContextDTO {
  id: number
  /** The printed bibliography line, verbatim. Present for every context. */
  raw_bib_text: string | null
  section: string | null
  role: string | null
  resolution_confidence: number | null
  occurrence_kind: string | null

  // ---- callout-site fields, produced by the `citation-contexts` stage ----
  // OPTIONAL (`?`), not merely nullable. The distinction is load-bearing:
  // `undefined` = the column does not exist / was not selected — nothing has
  //               analysed this paper's callouts yet.
  // `null`      = the stage RAN and genuinely found no value here (e.g. an
  //               author-year paper, whose callouts are deliberately not linked
  //               because two `Smith 2019` entries cannot be told apart).
  // Collapsing the two would make the UI report "no sentence found" for a paper
  // that was never processed, which is a different — and misleading — claim.
  /** Sentence carrying the callout. Captured TEXT, not a second anchor space. */
  sentence?: string | null
  /** Segmenter paragraph id of the callout site, e.g. "p87". */
  para_id?: string | null
  /** Absolute char offset of the callout in the canonical document text. */
  callout_offset?: number | null
  /** 1-based page the callout sits on. */
  page?: number | null

  // ---- CITED-side anchor ----
  // The fields above address the callout in the CITING paper. These address the
  // passage in the CITED paper that the callout points AT, which is the other
  // half of a two-sided citation claim: `verify-citations` puts the passage and
  // the cited paper's candidate blocks to a model, which confirms the reference
  // and names the block it is invoking. Filled ONLY for a link whose verdict is
  // `verified` — a rejected or unverifiable one carries no anchor, because
  // neither made any claim about where in the cited paper anything is.
  /** Segmenter paragraph id of the referenced passage in the CITED paper. */
  target_para_id?: string | null
  /** Text of the referenced passage in the CITED paper. */
  target_sentence?: string | null
  /** 1-based page of the referenced passage in the CITED paper. */
  target_page?: number | null
  /**
   * What a model concluded about this passage, or the absence of a conclusion.
   *
   * FIVE states, and they must never render as one another:
   *   `undefined`      the projection did not select it — an older database.
   *   `null`           nothing has checked this passage yet.
   *   `'verified'`     a model confirmed the passage references the cited paper.
   *                    A target may still be null: verified WITHOUT a located
   *                    block is an honest answer, not a failure.
   *   `'rejected'`     a model read it and said it does NOT reference that
   *                    paper. Excluded from the contexts a reader is shown.
   *   `'unverifiable'` nothing could be asked, because the cited paper has no
   *                    embedded text to point at. Not the model's verdict, and
   *                    labelling it as one would blame it for a question that
   *                    was never put to it.
   *   `'abstained'`    the model was shown the passage and returned no verdict.
   *                    Still shown to the reader — an unjudged citation is a
   *                    citation, and the parse that produced it is unaffected —
   *                    but it carries no confirmation.
   */
  link_verdict?: 'verified' | 'rejected' | 'unverifiable' | 'abstained' | null
  /** The model's own words on what decided the verdict. Uncalibrated. */
  link_reason?: string | null
  /** The model that verified it. Non-null whenever the verdict is a model's. */
  link_model?: string | null
  /**
   * Set when this context belongs to a reference that resolved to NOTHING.
   *
   * Exactly one of this and `edge_id` is set — a DB CHECK enforces the XOR, so
   * a context with no target is unrepresentable. On a typical corpus most
   * references are unresolved, so this arm is the common one, not the tail.
   */
  unresolved_reference_id?: number | null

  // ---- resolve split + role provenance, from the `citation-contexts` stage --
  // Optional for the same reason the callout fields above are: `undefined`
  // means the projection did not select them, not that the stage found nothing.
  /**
   * Which side of the resolve split this context's target is on, computed in
   * SQL. The UI must key off THIS, never off "is some id null" — edge ids and
   * unresolved ids overlap numerically, so an id-based guess mislabels one as
   * the other the moment the two ranges cross.
   */
  target_kind?: 'work' | 'unresolved'
  /**
   * Title of the cited work when the reference resolved; null when it did not.
   * The UI falls back to `raw_bib_text`, which is present for every parsed
   * entry because the stage writes one bibliography row per entry whether or
   * not a callout was ever found for it.
   */
  target_title?: string | null
  cited_work_id?: number | null
  edge_id?: number | null
  /** The citing paper. Non-null in the DB for every stage-written row. */
  citing_work_id?: number | null
  document_id?: number | null
  /** The bibliography entry number this callout names, e.g. 17 for "[17]". */
  ordinal?: number | null
  /**
   * One past the marker's last character, so the viewer highlights exactly the
   * printed marker instead of guessing its width from the ordinal.
   */
  callout_end?: number | null
  /**
   * `'rule'` or `'llm'`. Non-null whenever `role` is — a DB CHECK enforces it,
   * because a role of unknown origin is precisely what this column exists to
   * prevent: a regex and a calibrated model must never be ranked against each
   * other as though they were the same kind of claim.
   */
  role_source?: 'rule' | 'llm' | null
  /** The cue rule that fired, e.g. 'r5-support'. NULL for llm-derived roles. */
  role_cue?: string | null
}

export interface ApiError {
  error: string
  message: string
}
