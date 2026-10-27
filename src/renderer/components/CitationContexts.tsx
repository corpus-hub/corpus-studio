import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CitationContextDTO, CitationRole } from '@shared/types'
import { CITATION_ROLE_LABEL } from '@shared/types'
import type {
  UnresolvedReferenceDTO,
  ReferenceRetrievalStatus,
  CitationOutcomeDTO
} from '@shared/contract'
import type { PdfFindApi, PdfTextState } from './PdfDocView'
import { Select } from './ui'
import { plainText } from './RichText'

/**
 * The annId a selected citation context occupies in the viewer's highlight
 * namespace. Per-context rather than a single fixed id, so the band a click
 * draws can be traced back to the card that asked for it — and so the
 * authoritative anchored set (`onAnchoredIds`) can be consulted about THIS
 * context rather than about "whatever was focused last".
 */
export const citeAnnId = (contextId: number): string => `cc-${contextId}`

/**
 * The text a context can be located by, or null when it carries none.
 *
 * An in-text callout is addressed by its SENTENCE (the citance — the author's
 * own words about the cited paper), a bibliography occurrence by the printed
 * reference line. The stored `callout_offset`/`para_id` address the canonical
 * document text, which is a DIFFERENT coordinate space from the viewer's text
 * layer; anchoring by text is what the evidence-span path already does, so
 * citation contexts use it too rather than adding a second engine that could
 * disagree with the first.
 */
export function citeNeedle(c: CitationContextDTO): string | null {
  const s = c.sentence?.trim()
  if (s) return s
  const b = c.raw_bib_text?.trim()
  return b && b.length > 0 ? b : null
}

/**
 * The shortest needle the viewer's locator will even look for.
 *
 * `PdfDocView`'s `probe` refuses outright below this, and its highlight locator
 * uses the same figure as its default `minMatch` — so a shorter passage is not
 * "probably hard to find", it is one the engine declines to search for at all.
 * Duplicated as a constant rather than imported because it is `probe`'s
 * internal guard, not part of its exported surface.
 */
const LOCATOR_MIN_CANON = 12

/**
 * References drawn per page here.
 *
 * TEN, where the bibliography list opens on one. These are not the same kind of
 * list: a bibliography is consulted, and one row is enough to say it exists,
 * but a citation context is READ — it is the sentence in which this paper used
 * that reference, and a reader arriving here is already reading. Opening on one
 * would make them press a button before the section says anything.
 */
const CC_PAGE = 10

/** The locator's own canonical form: letters and digits, case-folded. */
const canonForLocator = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Whether a context is EVEN ELIGIBLE to be located, judged from the row alone.
 *
 * This is NOT a reachability answer and must never be presented as one. It
 * restates the locator's own PRECONDITION: no needle, or a needle below
 * `LOCATOR_MIN_CANON`, means the engine declines to search, so no jump can
 * possibly land. Callers that have a rendered document must still use
 * `PdfFindApi.probe` — this only lets a caller with NO viewer (the Connectome
 * popover, which draws no PDF) refuse honestly instead of guessing.
 *
 * It is NECESSARY but not SUFFICIENT, and the gap is named rather than papered
 * over: it reads the row and nothing else, so it cannot see whether the target
 * document has any extractable text at all. An image-only scan yields a needle
 * of any length and no page to find it on, and this returns true for it. A
 * caller with no viewer therefore still shows a jump that will not land in that
 * one case; closing it needs the document's text-availability carried on the
 * DTO, which it is not.
 */
export function citeLocatable(c: CitationContextDTO): boolean {
  const n = citeNeedle(c)
  return n !== null && canonForLocator(n).length >= LOCATOR_MIN_CANON
}

/**
 * How a context occurs, spelled out. `inline` means nothing on its own.
 *
 * `inline` maps to null because an in-text callout is what a citation context
 * ORDINARILY is — printing it on nine cards in ten spends a line saying nothing,
 * and takes the two kinds that ARE worth knowing about down with it.
 */
export const KIND_WORD: Record<string, string | null> = {
  inline: null,
  bibliography: 'bibliography entry',
  footnote: 'footnote'
}

/**
 * Whether a card can actually take the reader somewhere.
 *
 * Three values, and only ONE of them renders as pressable. `checking` exists
 * because reachability is not knowable until the document's text layer has
 * rendered: showing a pressable card during that window and having it fail
 * would be exactly the lie this repo treats as production-blocking, and showing
 * it as permanently inert would be a different lie a second later.
 */
type Reach = 'navigable' | 'inert' | 'checking'

/**
 * How a context's source document relates to the one the viewer is showing.
 *
 * `unknown` is deliberately NOT folded into `same`. A work can hold several
 * documents that paginate differently, so a page number is only meaningful
 * against the document it was read from — and a context that does not record
 * one cannot vouch for its own page.
 */
type DocRel = 'same' | 'other' | 'unknown'

/**
 * The document's text layer cannot be reached WHILE the viewer is showing
 * something else across the whole document.
 *
 * The find bar replaces every highlight for the duration (a deliberate,
 * temporary mode), and a `quote` deep link owns the viewer for the visit. In
 * both cases a citation card would set a selection that the highlight list
 * then discards: it would look pressable, say "showing in the document", and
 * draw nothing. So the whole surface goes inert and says which mode is holding
 * the viewer — a state with a way out, rather than a dead button.
 */
export type ViewerMode = 'free' | 'finding' | 'deep-link'

/** Why a card cannot navigate — shown on the card, never left to be guessed. */
function inertReason(
  c: CitationContextDTO,
  text: PdfTextState,
  mode: ViewerMode,
  unanchored: boolean
): string {
  if (mode === 'finding')
    return 'Search results are being shown in the document. Close the find bar (Esc) to jump to citations again.'
  if (mode === 'deep-link')
    return 'The document is showing the passage you followed here. Clear it to jump to citations again.'
  if (text === 'unavailable')
    return 'This paper’s document has no readable text — it is missing, failed to render, or is a scan that was never OCR’d — so there is nowhere to jump to.'
  if (unanchored)
    return 'This passage is stored, but the viewer could not find it in the rendered document — the PDF has changed since it was analysed, so jumping to it would land somewhere wrong.'
  if (!citeNeedle(c))
    return 'This context stores no sentence and no bibliography line, so there is no passage to find.'
  return 'This passage could not be found in the rendered document text, so there is nowhere reliable to jump to.'
}

/**
 * One group of contexts: everything this paper says about ONE cited reference.
 *
 * Grouped by TARGET rather than by page or section because the question a
 * reader brings here is "why does this paper cite that one" — the answer is the
 * set of places it does so, read together. Section and role are offered as
 * FILTERS over that, not as the primary axis, so no context is ever in two
 * groups at once and the counts add up.
 */
type Group = {
  key: string
  kind: 'work' | 'unresolved'
  /** The cited work id, when the reference resolved to a paper we hold. */
  workId: number | null
  unresolvedId: number | null
  title: string | null
  raw: string | null
  /**
   * How confidently the printed reference was matched to its target, or null
   * when nothing recorded it. Taken from the first context that carries one:
   * every context of a group describes the SAME match, so they agree by
   * construction, and a null everywhere stays null rather than becoming a
   * number.
   */
  confidence: number | null
  contexts: CitationContextDTO[]
}

function buildGroups(contexts: CitationContextDTO[]): Group[] {
  const byKey = new Map<string, Group>()
  for (const c of contexts) {
    // Keyed off `target_kind`, computed in SQL — never off "is some id null".
    // Edge ids and unresolved ids overlap numerically, so an id-based guess
    // mislabels one as the other the moment the two ranges cross.
    const resolved = c.target_kind === 'work'
    const key = resolved ? `e${c.edge_id}` : `u${c.unresolved_reference_id}`
    let g = byKey.get(key)
    if (!g) {
      g = {
        key,
        kind: resolved ? 'work' : 'unresolved',
        workId: resolved ? (c.cited_work_id ?? null) : null,
        unresolvedId: resolved ? null : (c.unresolved_reference_id ?? null),
        title: c.target_title ?? null,
        raw: null,
        confidence: null,
        contexts: []
      }
      byKey.set(key, g)
    }
    if (!g.raw && c.raw_bib_text) g.raw = c.raw_bib_text
    if (g.confidence === null && c.resolution_confidence !== null) {
      g.confidence = c.resolution_confidence
    }
    g.contexts.push(c)
  }
  // Insertion order is READING order: the query orders by page then callout
  // offset, so a group appears where the paper first reaches for it.
  return [...byKey.values()]
}

/** The two filter axes, kept separate because they are separate questions. */
type TargetFilter = 'all' | 'work' | 'unresolved'
type RoleFilter = 'all' | 'classified' | 'unclassified' | CitationRole

export function CitationContextSection({
  contexts,
  outcome,
  documentId,
  textState,
  mode,
  findApi,
  findEpoch,
  unanchored,
  selectedId,
  onSelect,
  onLocated,
  onOpenWork,
  unresolvedById,
  retrievalStatusOf,
  onRetrieve
}: {
  contexts: CitationContextDTO[]
  /**
   * What the `citation-contexts` stage CONCLUDED, or null if it never ran.
   *
   * Carried separately from the rows because the rows cannot express it: a
   * declined run and a ran-and-found-nothing run are row-identical.
   */
  outcome: CitationOutcomeDTO | null
  /** The document the viewer is showing, so a page number can be attributed to
   *  the file it actually belongs to. Null when there is no document at all. */
  documentId: number | null
  /** Whether the document's text is answerable yet, and whether it ever will be. */
  textState: PdfTextState
  /** What is holding the viewer, if anything. */
  mode: ViewerMode
  /**
   * The viewer's text index, once it exists. `probe` answers "would a jump to
   * this passage actually land?" for every context against ONE index build.
   */
  findApi: PdfFindApi | null
  /** Bumped whenever the index is rebuilt (zoom, re-render), so probes re-run. */
  findEpoch: number
  /**
   * Contexts the viewer's AUTHORITATIVE anchored set later refused, after a
   * click drew (or failed to draw) a band. The probe is a prediction; this is
   * the observation, and it wins.
   */
  unanchored: Set<number>
  selectedId: number | null
  onSelect: (c: CitationContextDTO | null) => void
  /**
   * Where each locatable context was FOUND, as a fraction of the document.
   * Reported up so the highlight the parent builds anchors to the occurrence
   * the probe actually resolved, rather than to a different copy of the same
   * sentence. Stable identity required — it is an effect dependency.
   */
  onLocated: (fracById: Map<number, number>) => void
  onOpenWork?: (workId: number) => void
  /** The unresolved-reference rows, so a group can offer the SAME import action
   *  the Unresolved references list offers, wired to the same live state. */
  unresolvedById: Map<number, UnresolvedReferenceDTO>
  retrievalStatusOf: (r: UnresolvedReferenceDTO) => ReferenceRetrievalStatus
  onRetrieve: (r: UnresolvedReferenceDTO) => void
}): JSX.Element {
  const groups = useMemo(() => buildGroups(contexts), [contexts])

  const docRelOf = useCallback(
    (c: CitationContextDTO): DocRel => {
      if (c.document_id === null || c.document_id === undefined) return 'unknown'
      if (documentId === null) return 'other'
      return c.document_id === documentId ? 'same' : 'other'
    },
    [documentId]
  )

  // ---- reachability: which contexts can actually be jumped to ----
  // Batched: one text-index build answers every context. Calling the locator
  // per card would rebuild the index once per context — on this corpus that is
  // 500+ full walks of every span in the document.
  const [reach, setReach] = useState<{ epoch: number; ok: Map<number, number> } | null>(null)
  useEffect(() => {
    // Only probe a document that is FULLY indexed. Mid-render the index covers
    // a prefix, so a passage on a later page has legitimately not been found
    // yet — asserting "not locatable" about it would be a definitive answer
    // that silently flips a second later, which reads as the app changing its
    // mind about the evidence.
    if (!findApi || textState !== 'ready') {
      setReach(null)
      return
    }
    const ids: number[] = []
    const queries: Array<{ text: string; near?: number | null }> = []
    for (const c of contexts) {
      const n = citeNeedle(c)
      if (n) {
        ids.push(c.id)
        // The stored page is a HINT, used only to pick between repeated
        // occurrences of the same text. It is never trusted as an anchor: it
        // addresses the canonical document text, which is a different
        // coordinate space from the rendered layer.
        queries.push({ text: n, near: c.page ?? null })
      }
    }
    const hits = findApi.probe(queries)
    // id -> where the probe FOUND it. Handed back to the viewer as `frac` when
    // the card is pressed, so the band lands on that occurrence rather than on
    // whichever copy the locator's running cursor reaches first.
    const ok = new Map<number, number>()
    ids.forEach((id, i) => {
      const frac = hits[i]
      if (frac !== null && frac !== undefined) ok.set(id, frac)
    })
    setReach({ epoch: findEpoch, ok })
    onLocated(ok)
  }, [findApi, findEpoch, contexts, textState, onLocated])

  const reachOf = useCallback(
    (c: CitationContextDTO): Reach => {
      // The viewer is showing something else across the whole document, so a
      // selection here would be discarded and the card would draw nothing.
      if (mode !== 'free') return 'inert'
      // A settled NO: no readable text, and waiting will not produce any.
      if (textState === 'unavailable') return 'inert'
      if (unanchored.has(c.id)) return 'inert'
      if (!citeNeedle(c)) return 'inert'
      // The index was rebuilt (zoom, re-render) and this answer predates it.
      // Reporting the stale verdict would let a card claim reachability from an
      // index that no longer exists.
      if (!reach || reach.epoch !== findEpoch) return 'checking'
      return reach.ok.has(c.id) ? 'navigable' : 'inert'
    },
    [textState, mode, reach, findEpoch, unanchored]
  )

  // ---- filters ----
  const [target, setTarget] = useState<TargetFilter>('all')
  const [role, setRole] = useState<RoleFilter>('all')

  /**
   * How many REFERENCES are drawn, not how many contexts.
   *
   * A paper citing ninety works has ninety groups here, each carrying its own
   * quoted passages, and drawn whole they bury every section below. Paging by
   * group rather than by context keeps a reference's passages together — half
   * a reference's quotes with the rest behind a button would read as though
   * the paper cited it that many times.
   *
   * Reset whenever the filters move: a count taken against the old list would
   * offer to reveal rows the new one does not have, and "12 of 4" is the kind
   * of number that makes a reader distrust every other one on the screen.
   */
  const [visibleGroups, setVisibleGroups] = useState(CC_PAGE)
  useEffect(() => {
    setVisibleGroups(CC_PAGE)
  }, [target, role])

  const roleCounts = useMemo(() => {
    const m = new Map<string, number>()
    let none = 0
    for (const c of contexts) {
      if (c.role) m.set(c.role, (m.get(c.role) ?? 0) + 1)
      else none++
    }
    return { byRole: m, none, classified: contexts.length - none }
  }, [contexts])

  const targetCounts = useMemo(() => {
    let work = 0
    for (const g of groups) if (g.kind === 'work') work++
    return { work, unresolved: groups.length - work }
  }, [groups])

  const keepContext = useCallback(
    (c: CitationContextDTO): boolean => {
      if (role === 'all') return true
      if (role === 'classified') return c.role !== null && c.role !== undefined
      if (role === 'unclassified') return !c.role
      return c.role === role
    },
    [role]
  )

  const shown = useMemo(() => {
    const out: Array<Group & { hidden: number }> = []
    for (const g of groups) {
      if (target !== 'all' && g.kind !== target) continue
      const kept = role === 'all' ? g.contexts : g.contexts.filter(keepContext)
      if (kept.length === 0) continue
      out.push({ ...g, contexts: kept, hidden: g.contexts.length - kept.length })
    }
    return out
  }, [groups, target, role, keepContext])

  const shownContexts = useMemo(
    () => shown.reduce((n, g) => n + g.contexts.length, 0),
    [shown]
  )

  /**
   * The stage DECLINED to link this paper's callouts.
   *
   * Read from the stage's own terminal record, never inferred from the rows.
   * The rows cannot answer it: a `refused` run and an `empty` one both write
   * one bibliography row per reference and no in-text rows, so a predicate over
   * `occurrence_kind` labels every paper of one kind with the other's meaning —
   * which is the same class of confident falsehood this banner was added to
   * remove, merely pointing the other way.
   */
  const declined = outcome?.status === 'refused'

  /* Both axes survive the chips→select move: they answer different questions and
     fusing them would make "in corpus AND method used" unaskable. The count
     rides in the option LABEL rather than in a chip of its own, so a reader can
     still see how much each choice would hide before choosing it. */
  const roleOptions: Array<{ key: RoleFilter; label: string; count: number }> = [
    { key: 'all', label: 'Any use', count: contexts.length },
    { key: 'classified', label: 'Classified', count: roleCounts.classified },
    ...[...roleCounts.byRole.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => ({
        key: r as RoleFilter,
        label: CITATION_ROLE_LABEL[r as CitationRole] ?? r,
        count: n
      })),
    { key: 'unclassified', label: 'Not classified', count: roleCounts.none }
  ]

  const targetOptions: Array<{ key: TargetFilter; label: string; count: number }> = [
    { key: 'all', label: 'All references', count: groups.length },
    { key: 'work', label: 'In corpus', count: targetCounts.work },
    { key: 'unresolved', label: 'Not in corpus', count: targetCounts.unresolved }
  ]

  return (
    <div className="pv-section cc-section" data-testid="citation-contexts">
      <div className="pv-section-eyebrow mono">Citation contexts</div>
      <p className="cc-lede">
        Every place this paper reaches for another, in the author’s own sentence.
        <span className="cc-lede-count mono" data-testid="cc-total">
          {contexts.length} context{contexts.length === 1 ? '' : 's'} · {groups.length} reference
          {groups.length === 1 ? '' : 's'}
        </span>
      </p>

      {/* The abstention, stated where the missing sentences would have been.
          A paper whose callout linking was declined has bibliography rows and
          no in-text ones, so the section renders as a bare list of references
          with no contexts — visually identical to a paper that simply cites
          nothing in its prose. On this corpus that is 6 papers in 20 silently
          reading as "nobody is quoted here". Derived from the rows rather than
          from the stage row, because it is the rows the reader is looking at. */}
      {declined && (
        <div className="cc-declined" data-testid="cc-declined">
          <span className="cc-declined-glyph" aria-hidden="true">
            ⊘
          </span>
          <span className="cc-declined-body">
            <strong className="cc-declined-head">In-text citations were not linked</strong>
            <span className="cc-declined-lede">
              The {groups.length} reference{groups.length === 1 ? '' : 's'} below were read, but
              which sentence cites which paper could not be determined confidently — so nothing was
              guessed.
            </span>
            {/* The stage's OWN words, on their own line rather than run into the
                sentence above. The fixed prose cannot be right for every
                refusal: an author-year paper is declined because its callouts
                are names and years, while a numbering-confidence refusal reports
                the counts it saw. Flattening those into one sentence describes
                the wrong cause on whichever kind the reader is looking at. */}
            {outcome?.note && (
              <span className="cc-declined-reason mono" data-testid="cc-declined-reason">
                {outcome.note}
              </span>
            )}
          </span>
        </div>
      )}

      {mode !== 'free' && (
        <div className="cc-mode-note" data-testid="cc-mode-note">
          {mode === 'finding'
            ? 'The document is showing search results, so citations cannot be jumped to. Close the find bar (Esc) to bring them back.'
            : 'The document is showing the passage you followed here, so citations cannot be jumped to until it is cleared.'}
        </div>
      )}
      {mode === 'free' && textState === 'unavailable' && (
        <div className="cc-mode-note" data-testid="cc-text-note">
          This paper’s document has no readable text, so these contexts can be read but not jumped
          to.
        </div>
      )}

      {/* A control surface taller than its first result is a control surface
          nobody reads. Two selects on one line replace eleven chips on two
          labelled rows; a select that is ACTIVELY hiding rows is tinted, because
          a filter the reader has forgotten about looks exactly like a corpus
          that holds less than it does. */}
      <div className="cc-filters">
        <Select<TargetFilter>
          className={`cc-select${target !== 'all' ? ' is-narrowed' : ''}`}
          testid="cc-target-select"
          ariaLabel="Filter by whether the cited paper is in the corpus"
          value={target}
          options={targetOptions.map((o) => ({
            value: o.key,
            label: `${o.label} (${o.count})`
          }))}
          onChange={setTarget}
        />
        <Select<RoleFilter>
          className={`cc-select${role !== 'all' ? ' is-narrowed' : ''}`}
          testid="cc-role-select"
          ariaLabel="Filter by how the citation is used"
          value={role}
          options={roleOptions.map((o) => ({
            value: o.key,
            label: `${o.label} (${o.count})`
          }))}
          onChange={setRole}
        />
      </div>

      {(target !== 'all' || role !== 'all') && (
        <div className="cc-filter-note" data-testid="cc-filter-note">
          Showing {shownContexts} of {contexts.length} contexts across {shown.length} of{' '}
          {groups.length} references.
          <button
            type="button"
            className="btn-link cc-filter-clear"
            data-testid="cc-filter-clear"
            onClick={() => {
              setTarget('all')
              setRole('all')
            }}
          >
            clear filters
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="pv-empty" data-testid="cc-empty">
          No citation context matches these filters.
        </div>
      ) : (
        <div className="cc-groups">
          {shown.slice(0, visibleGroups).map((g) => (
            <CitationGroup
              key={g.key}
              group={g}
              hiddenByFilter={g.hidden}
              reachOf={reachOf}
              docRelOf={docRelOf}
              textState={textState}
              mode={mode}
              unanchored={unanchored}
              selectedId={selectedId}
              onSelect={onSelect}
              onOpenWork={onOpenWork}
              unresolvedRef={g.unresolvedId !== null ? unresolvedById.get(g.unresolvedId) : undefined}
              retrievalStatusOf={retrievalStatusOf}
              onRetrieve={onRetrieve}
            />
          ))}
          {shown.length > visibleGroups && (
            <button
              type="button"
              className="pv-ref-more"
              data-testid="cc-more"
              onClick={() => setVisibleGroups((n) => n + CC_PAGE)}
            >
              Show {Math.min(CC_PAGE, shown.length - visibleGroups)} more
              <span className="pv-ref-more-count mono">
                {visibleGroups} of {shown.length}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CitationGroup({
  group,
  hiddenByFilter,
  reachOf,
  docRelOf,
  textState,
  mode,
  unanchored,
  selectedId,
  onSelect,
  onOpenWork,
  unresolvedRef,
  retrievalStatusOf,
  onRetrieve
}: {
  group: Group
  hiddenByFilter: number
  reachOf: (c: CitationContextDTO) => Reach
  docRelOf: (c: CitationContextDTO) => DocRel
  textState: PdfTextState
  mode: ViewerMode
  unanchored: Set<number>
  selectedId: number | null
  onSelect: (c: CitationContextDTO | null) => void
  onOpenWork?: (workId: number) => void
  unresolvedRef?: UnresolvedReferenceDTO
  retrievalStatusOf: (r: UnresolvedReferenceDTO) => ReferenceRetrievalStatus
  onRetrieve: (r: UnresolvedReferenceDTO) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // A group holding the selected context must be open, or the selection would
  // be invisible — including when the selection came from a click in the PDF.
  const holdsSelection = selectedId !== null && group.contexts.some((c) => c.id === selectedId)
  const expanded = open || holdsSelection

  const resolved = group.kind === 'work'
  const heading = resolved
    ? (group.title ?? group.raw ?? 'Untitled work')
    : (unresolvedRef?.guessed_title ?? group.raw ?? 'Unnamed reference')

  /**
   * Everything the header used to PRINT about this reference, said once, where
   * a reader who wants it can ask.
   *
   * The printed line and the match confidence are provenance: they answer "on
   * what authority is this the right paper", which is a question asked about one
   * group at a time, not about all forty-six at once. Confidence is an em-dash
   * where none was stored, never a number — most matches on this corpus are
   * unquantified and inventing a figure would let a string comparison read as a
   * calibrated one.
   *
   * The printed line is dropped when it is ALREADY the heading. `heading` falls
   * back to `group.raw` for a reference that resolved to no title, and quoting a
   * string back to a reader who is looking straight at it reads as a fault.
   */
  const titleTip = [
    group.raw === heading ? null : group.raw,
    resolved
      ? group.confidence === null
        ? 'Matched to a paper in the corpus; how confidently was not recorded.'
        : `Matched to a paper in the corpus, ${Math.round(group.confidence * 100)}% confidence.`
      : 'This reference matched nothing in the corpus.',
    expanded
      ? 'Collapse the places this paper cites it.'
      : 'Show the places this paper cites it, sentence by sentence.'
  ]
    .filter((s): s is string => Boolean(s))
    .join(' — ')

  return (
    <div
      className={`cc-group${expanded ? ' is-open' : ''} cc-group-${resolved ? 'in' : 'out'}`}
      data-testid={`cc-group-${group.key}`}
    >
      <button
        type="button"
        className="cc-group-head"
        aria-expanded={expanded}
        data-testid={`cc-group-${group.key}-toggle`}
        data-tip={titleTip}
        onClick={() => setOpen((v) => !v)}
      >
        {/* ONE glyph, rotated. Swapping ▸ for ▾ cannot be eased: the two are
            different characters, so the open/close would snap. */}
        <span className="cc-caret" aria-hidden="true">
          ▸
        </span>
        <span className="cc-group-title">
          {heading}
          {!resolved && (
            <span
              className="cc-out mono"
              data-tip="This reference matched nothing in the corpus. Its printed line is preserved below; it can be looked up and imported."
            >
              not in corpus
            </span>
          )}
        </span>
        <span className="cc-group-n mono">
          {group.contexts.length}
          {hiddenByFilter > 0 ? ` of ${group.contexts.length + hiddenByFilter}` : ''}
        </span>
      </button>

      {expanded && (
        <div className="cc-places">
          {group.contexts.map((c) => (
            <CalloutCard
              key={c.id}
              ctx={c}
              reach={reachOf(c)}
              docRel={docRelOf(c)}
              selected={selectedId === c.id}
              reason={inertReason(c, textState, mode, unanchored.has(c.id))}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {expanded && resolved && group.workId !== null && onOpenWork && (
        <button
          type="button"
          className="pv-ref-open"
          data-testid={`cc-group-${group.key}-open`}
          aria-label={`Read ${heading}`}
          onClick={() => onOpenWork(group.workId as number)}
        >
          Read →
        </button>
      )}
      {expanded && !resolved && unresolvedRef && (
        <RetrieveStrip
          testid={`cc-group-${group.key}`}
          title={unresolvedRef.guessed_title}
          state={retrievalStatusOf(unresolvedRef)}
          retrievable={unresolvedRef.retrieval_kind !== null}
          error={unresolvedRef.retrieval_error}
          onRetrieve={() => onRetrieve(unresolvedRef)}
        />
      )}
    </div>
  )
}

/** What the retrieve strip says and how it is styled, per retrieval state. */
const RETRIEVE_STATE: Record<
  ReferenceRetrievalStatus,
  { label: string; mod: string; tip: string }
> = {
  none: {
    label: 'Import',
    mod: '',
    tip: 'Search for this paper and pull it into the corpus.'
  },
  retrieving: {
    label: 'Importing…',
    mod: 'is-busy',
    tip: 'This paper is being fetched. The card updates itself when the job ends.'
  },
  failed: {
    label: 'Retry',
    mod: 'is-failed',
    tip: 'The last attempt failed.'
  },
  retrieved: {
    label: 'Imported ✓',
    mod: 'is-done',
    tip: 'This paper is already in the corpus. Reload the screen to read it.'
  }
}

/**
 * The SAME import control the Unresolved references list offers,
 * reusing its classes and its live retrieval state, so the two places a reader
 * can start an import cannot disagree about whether one is already running.
 *
 * `aria-disabled` with an inert handler, NOT the `disabled` attribute: a
 * disabled button receives no pointer events, so the delegated tooltip would
 * never fire and the state that most needs explaining would explain nothing.
 */
export function RetrieveStrip({
  testid,
  title,
  state,
  retrievable,
  error,
  onRetrieve
}: {
  testid: string
  title?: string | null
  state: ReferenceRetrievalStatus
  retrievable: boolean
  error: string | null
  onRetrieve: () => void
}): JSX.Element {
  const meta = RETRIEVE_STATE[state]
  const inert = !retrievable || state === 'retrieving' || state === 'retrieved'
  const tip = !retrievable
    ? 'This entry names no DOI, title or venue, so there is nothing to look up.'
    : state === 'failed' && error
      ? `The last attempt failed: ${error}. Press to try again.`
      : meta.tip
  return (
    <button
      type="button"
      className={`pv-ref-open pv-ref-retrieve ${meta.mod} ${retrievable ? '' : 'is-unretrievable'}`}
      data-testid={`${testid}-retrieve`}
      data-state={retrievable ? state : 'unretrievable'}
      data-tip={tip}
      aria-disabled={inert || undefined}
      aria-busy={state === 'retrieving' || undefined}
      aria-label={title ? `${meta.label}: ${plainText(title)}` : meta.label}
      onClick={inert ? undefined : onRetrieve}
    >
      <span className="pv-ref-retrieve-dot" aria-hidden="true" />
      {retrievable ? meta.label : 'Nothing to look up'}
    </button>
  )
}

/**
 * ONE place a citation happens: the sentence, where it sits, and how it is used.
 *
 * Rendered as a <button> ONLY when it can actually take the reader there. The
 * inert case is a <div> with `aria-disabled`, a flat surface and a stated
 * reason — never a button that looks pressable and then draws nothing.
 */
function CalloutCard({
  ctx,
  reach,
  selected,
  reason,
  docRel,
  onSelect
}: {
  ctx: CitationContextDTO
  reach: Reach
  selected: boolean
  reason: string
  /**
   * How this context's source document relates to the one on screen.
   * `unknown` is its own answer, not a synonym for `same`: a context that does
   * not record which document it was read from cannot vouch for a page number,
   * and quietly printing one would be a claim nothing supports.
   */
  docRel: DocRel
  onSelect: (c: CitationContextDTO | null) => void
}): JSX.Element {
  // `in` rather than `??`: a KNOWN kind mapped to null is a deliberate silence,
  // and `??` would fall through it and print the raw enum instead.
  const kind = !ctx.occurrence_kind
    ? null
    : ctx.occurrence_kind in KIND_WORD
      ? KIND_WORD[ctx.occurrence_kind]
      : ctx.occurrence_kind
  const quote = ctx.sentence?.trim() || ctx.raw_bib_text?.trim() || ''

  /* The sentence first, and everything about it after it in one quiet line.
     The head that used to sit ABOVE the quote pushed the thing the reader came
     for down past three chips of metadata on every one of a hundred cards. */
  const body = (
    <>
      <span className="cc-place-quote">{quote || '—'}</span>
      <span className="cc-place-foot">
        <RoleMark ctx={ctx} />
        {kind && <span className="cc-place-kind mono">{kind}</span>}
        {ctx.section && <span className="cc-place-where mono">{ctx.section}</span>}
        {docRel === 'other' && (
          <span
            className="cc-place-otherdoc mono"
            data-testid={`cc-otherdoc-${ctx.id}`}
            data-tip="This context was read from a different version of this paper than the one on screen, so it describes a document other than the one on screen."
          >
            other version
          </span>
        )}
        <span className="cc-foot-spacer" />
        {/* Only the card that CANNOT be jumped to speaks unprompted. A
            navigable card IS the button, so its affordance is revealed by the
            pointer rather than printed on every row. */}
        {reach === 'navigable' ? (
          <span className="cc-place-jump mono" aria-hidden="true">
            {selected ? 'showing ◆' : 'show ↳'}
          </span>
        ) : (
          <span className="cc-place-blocked mono">
            {reach === 'checking' ? 'locating…' : 'not locatable'}
          </span>
        )}
      </span>
    </>
  )

  const cls = `cc-place cc-place-${reach}${selected ? ' is-selected' : ''}`

  if (reach !== 'navigable') {
    return (
      <div
        className={cls}
        data-testid={`cc-place-${ctx.id}`}
        data-reach={reach}
        aria-disabled="true"
        data-tip={
          reach === 'checking'
            ? 'The document is still rendering. This card says whether it can be jumped to as soon as that is known.'
            : reason
        }
      >
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={cls}
      data-testid={`cc-place-${ctx.id}`}
      data-reach="navigable"
      aria-pressed={selected}
      data-tip={
        selected
          ? 'This passage is highlighted in the document. Press again to clear it.'
          : 'Scroll the document to this sentence and highlight it.'
      }
      onClick={() => onSelect(selected ? null : ctx)}
    >
      {body}
    </button>
  )
}

/**
 * How the citation is used, and on whose authority.
 *
 * The three cases are visually and verbally distinct, because they are
 * different kinds of claim:
 *  - a RULE match is deterministic: the cue that fired is named on the role's
 *    own tooltip, where a reader who doubts the label will ask, instead of
 *    spending a chip on every card to print an internal id;
 *  - an LLM label is a judgement, and says so;
 *  - NO label is the absence of a claim. It renders as "not classified" — never
 *    as `other`, which is a positive class meaning a classifier looked and found
 *    none of the named uses to fit.
 */
function RoleMark({ ctx }: { ctx: CitationContextDTO }): JSX.Element {
  if (!ctx.role) {
    return (
      <span
        className="cc-role cc-role-none"
        data-testid={`cc-role-none-${ctx.id}`}
        data-tip="No classifier assigned a use to this callout. This is the absence of a label, not a label."
      >
        not classified
      </span>
    )
  }
  const label = CITATION_ROLE_LABEL[ctx.role as CitationRole] ?? ctx.role
  const bySource = ctx.role_source
  return (
    <span className="cc-role-wrap">
      <span
        className="cc-role cc-role-set"
        data-role={ctx.role}
        data-testid={`cc-role-${ctx.id}`}
        data-tip={
          bySource === 'rule'
            ? `A deterministic cue rule matched the sentence${
                ctx.role_cue ? ` (${ctx.role_cue})` : ''
              }.`
            : undefined
        }
      >
        {label}
      </span>
      {bySource === 'llm' && (
        <span
          className="cc-rolesrc cc-rolesrc-llm mono"
          data-testid={`cc-llm-${ctx.id}`}
          data-tip="A model judged this use. A model's judgement and a regex match are never ranked against each other as though they were the same kind of claim."
        >
          model
        </span>
      )}
    </span>
  )
}
