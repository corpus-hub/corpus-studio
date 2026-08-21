// The citation evidence card — the body shown when a citation line is hovered,
// pinned or clicked.
//
// SHARED by the connectome (which pins it on an edge click) and the reference
// tree (which opens it on a line click). It was a closure inside GraphScreen;
// two screens drawing the same citation had to show the same thing, and a
// second copy would have drifted the moment either was touched.

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CitationContextDTO, CitationEdgeDTO, CitationRole } from '@shared/types'
import { CITATION_ROLE_LABEL } from '@shared/types'
import { PaperThumb } from './PaperThumb'
import { citeNeedle, citeLocatable } from './CitationContexts'
import { RichText, plainText } from './RichText'

const roleLabel = (role: string | null): string =>
  CITATION_ROLE_LABEL[role as CitationRole] ?? role ?? ''

/**
 * A section value, said the way a reader says it.
 *
 * Case-folded because the corpus holds both `references` and `References` for
 * the same section, and printing them differently claims a distinction the data
 * does not carry.
 *
 * `title` is the front-matter bucket — the title block, authors and
 * affiliations — and it names a real place, so it is spelled out.
 *
 * `other` is the segmenter's admission that it could not place the sentence.
 * It yields null, so no section is named — and nothing is laundered by that,
 * because the PAGE beside it is exact and is still shown. The reader is told
 * where the sentence is, minus a section nobody knows.
 */
const sectionLabel = (section: string | null | undefined): string | null => {
  if (!section) return null
  const s = section.trim().toLowerCase()
  if (s.length === 0) return null
  if (s === 'title') return 'front matter'
  if (s === 'other') return null
  return s
}

/**
 * The kind, said in as few words as the distinction needs.
 *
 * Shorter than the shared `KIND_WORD` (used where a kind stands alone in a
 * column): here it sits on a single line beside the role and the page, and a
 * glyph already carries the in-text/entry distinction.
 */
const COMPACT_KIND_WORD: Record<string, string> = {
  inline: 'in-text',
  bibliography: 'bibliography',
  footnote: 'footnote'
}

/**
 * The THREE taxonomies a citation occurrence carries, kept apart.
 *
 * They are different kinds of claim about different things, and the old card
 * rendered two of them as adjacent unlabelled chips and dropped the third — so
 * a printed bibliography line read as `unclassified · references`, i.e. "an
 * unclassified sentence in the References section", when it actually means
 * "this is the reference list entry, which has no sentence and no role".
 *
 *  - KIND (`occurrence_kind`): WHAT this row is. An in-text callout is the
 *    author writing about the cited paper; a bibliography entry is the printed
 *    line in the reference list. This one comes first because it decides
 *    whether the other two are even meaningful.
 *  - USE (`role`): HOW the citation is used. Only in-text prose has one. What
 *    DECIDED the role (`role_source`/`role_cue`) is carried
 *    on the DTO and shown on the Paper screen, not here.
 *  - PLACE (`section`, `page`): WHERE in the citing paper the sentence sits.
 */
type Taxonomy = {
  /** `bibliography` | `inline` | `footnote` | … — never guessed from nulls. */
  kind: string | null
  kindWord: string | null
  /** True when a role would be a category error, not merely a missing value. */
  roleNotApplicable: boolean
  role: string | null
  section: string | null
  page: number | null
}

const taxonomyOf = (c: CitationContextDTO): Taxonomy => {
  const kind = c.occurrence_kind ?? null
  // A bibliography entry is a printed line, not a sentence making an argument,
  // so it HAS no use to classify. Calling that "unclassified" is a false claim
  // about the row rather than an honest gap — the producer deliberately leaves
  // it null (`citation-contexts.ts`: "An ENTRY has no role").
  const roleNotApplicable = kind === 'bibliography'
  return {
    kind,
    kindWord: kind ? (COMPACT_KIND_WORD[kind] ?? kind) : null,
    roleNotApplicable,
    role: c.role ?? null,
    // A bibliography entry sits in the reference list by definition, so its
    // `section` restates the kind and adds nothing.
    section: roleNotApplicable ? null : sectionLabel(c.section),
    page: c.page ?? null
  }
}

/**
 * The occurrences a card can actually SHOW: the ones carrying a passage.
 *
 * The header's count and the list below it must be the same number. They were
 * not: the header printed `contexts.length` while the list rendered only the
 * contexts holding a sentence or a printed reference line, so a context with
 * neither was counted and then never appeared — the card contradicting its own
 * body. One function now answers both.
 */
export const shownContexts = (edge: CitationEdgeDTO): CitationContextDTO[] =>
  edge.contexts.filter((c) => c.sentence || c.raw_bib_text)

/** "3 occurrences" / "1 occurrence", counting exactly what is listed. */
export const occurrenceCount = (edge: CitationEdgeDTO): string => {
  const n = shownContexts(edge).length
  return `${n} ${n === 1 ? 'occurrence' : 'occurrences'}`
}

/**
 * ONE occurrence of a citation, with its three taxonomies told apart.
 *
 * Layout is a labelled two-line head rather than a row of bare chips: every
 * mark sits under a word saying WHICH question it answers, so none of them has
 * to be guessed at. The reader who had to ask "what do 'references' and
 * 'results' mean?" was reading unlabelled chips.
 */
function OccurrenceRow({
  ctx,
  citingTitle,
  citingWorkId,
  interactive,
  onOpenQuote
}: {
  ctx: CitationContextDTO
  citingTitle: string
  citingWorkId: number
  /** A card that FOLLOWS the pointer can hold no controls — you cannot reach
   *  them. The hover card is that card; the pinned one is not. */
  interactive: boolean
  onOpenQuote?: (workId: number, quote: string) => void
}): JSX.Element {
  const t = taxonomyOf(ctx)
  const quote = citeNeedle(ctx)
  // Whether the passage can be jumped to at all. `citeLocatable` restates the
  // viewer's OWN precondition (a needle at least 12 canonical characters long),
  // so a `false` here is the locator declining to search, not a guess.
  //
  // `interactive` is deliberately NOT part of this. It says whether the CARD can
  // hold a control, not whether the passage can be reached, and folding it in
  // made the hover card assert "not locatable" about every passage on it.
  const locatable = onOpenQuote !== undefined && citeLocatable(ctx)
  // A quote clamps to 4 lines so the popover stays a glance rather than a
  // reader. Clamping with no way past it hides evidence, so the clamp is a
  // control, not a wall.
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const quoteRef = useRef<HTMLDivElement | null>(null)
  // Only offer "show all" when the text is ACTUALLY cut off. A permanent
  // expander on a two-line quote is a control that does nothing, which is the
  // same defect as a button with no handler.
  useEffect(() => {
    const el = quoteRef.current
    if (!el) return
    const measure = (): void =>
      setClamped(el.scrollHeight - el.clientHeight > 2 || open)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [quote, open])

  // Why a jump cannot be offered — and it is only ever said when it is TRUE of
  // the PASSAGE. `interactive` is a fact about the CARD (the hover card follows
  // the pointer and has `pointer-events: none`, so nothing on it can be reached
  // or even hovered for a tip), and printing "not locatable" there would state
  // something false about a passage that is perfectly locatable, on the one card
  // whose tooltip could never fire to correct it.
  const inertReason = !quote
    ? 'This occurrence stores no sentence and no printed reference line, so there is no passage to find.'
    : !onOpenQuote
      ? 'This view cannot open papers, so there is nowhere for a jump to go.'
      : 'This passage is too short for the document locator to search for, so a jump could not be made to land on it reliably.'

  return (
    <div className="cg-edgecard-ctx" data-testid={`edgecard-ctx-${ctx.id}`} data-kind={t.kind ?? 'unknown'}>
      {/* ONE line, read left to right: what the row is, how it is used, where
          it sits. The glyph, the weight and the `p.` prefix each say which
          question is being answered, and the full sentence of each is in its
          tooltip and aria-label for the reader who wants it. */}
      <div className="cg-edgecard-marks" data-testid={`edgecard-marks-${ctx.id}`}>
        <span
          className="cg-mark-value cg-mark-kind-value"
          data-kind={t.kind ?? 'unknown'}
          data-testid={`edgecard-kind-${ctx.id}`}
          aria-label={
            t.kind === 'bibliography'
              ? 'This row is a bibliography entry.'
              : t.kind === 'inline'
                ? 'This row is an in-text callout.'
                : t.kind === 'footnote'
                  ? 'This row is a footnote citation.'
                  : 'How this citation occurs was not recorded.'
          }
          data-tip={
            t.kind === 'bibliography'
              ? 'The printed line in this paper’s reference list. It names the cited paper; it is not a sentence the author wrote about it.'
              : t.kind === 'inline'
                ? 'A citation marker in the body text, shown with the sentence around it — the author’s own words about the cited paper.'
                : t.kind === 'footnote'
                  ? 'A citation that appears in a footnote rather than the body text.'
                  : 'How this citation occurs was not recorded for this row.'
          }
        >
          {t.kindWord ?? 'kind unrecorded'}
        </span>

        {t.roleNotApplicable ? (
          // NOT "unclassified". A reference-list line has no argumentative
          // use to classify, so claiming a classifier failed on it would be
          // a false statement about the row rather than a missing value.
          <span
            className="cg-mark-value cg-role-na"
            data-testid={`edgecard-role-na-${ctx.id}`}
            aria-label="No use to classify: a reference-list entry makes no argument. This is “does not apply”, not “nobody has looked”."
            data-tip="A reference-list entry makes no argument, so there is no use to classify. This is “does not apply”, not “nobody has looked”."
          >
            no argument to classify
          </span>
        ) : !t.role ? (
          <span
            className="cg-mark-value cg-role-none"
            data-testid={`edgecard-role-none-${ctx.id}`}
            aria-label="Not classified yet — no label has been assigned, which is not the same as the “other” class."
            data-tip={
              ctx.sentence
                ? 'No cue rule matched this sentence and no model has classified it yet. This is the ABSENCE of a label — it is not “other”, which is a positive class meaning a classifier read the sentence and found none of the named uses to fit.'
                : 'No sentence was captured around this callout, so there was no text for a cue rule or a model to read. Nothing has classified it, and nothing could have.'
            }
          >
            not classified yet
          </span>
        ) : (
          <span
            className="cg-mark-value cg-role-set"
            data-role={t.role}
            data-testid={`edgecard-role-${ctx.id}`}
            aria-label={`Used as: ${roleLabel(t.role)}.`}
            data-tip={
              t.role === 'other'
                ? 'A classifier read this sentence and found none of the named uses to fit. That is a POSITIVE finding — it is not the same as “not classified yet”, which means nobody has looked.'
                : 'How this paper uses the citation.'
            }
          >
            {roleLabel(t.role)}
          </span>
        )}

        {/* WHERE it sits: a section when one is known, and the page, which is
            exact. Drawn only when there is something to say — an em-dash here
            still asserts a location was looked for. */}
        {(t.section || t.page != null) && (
          <span
            className="cg-mark-value cg-place-value mono"
            data-testid={`edgecard-place-${ctx.id}`}
            aria-label={`Found in ${[t.section, t.page != null ? `page ${t.page}` : null]
              .filter(Boolean)
              .join(', ')}.`}
            // The no-section branch says only that no section is NAMED. It used
            // to say the section "could not be determined", which is true of
            // the segmenter's `other` bucket and false of a row whose section
            // was simply never recorded — two different silences, and the row
            // does not know which one it is holding.
            data-tip={
              t.section
                ? 'Where in the citing paper this sits: its section, and the page of the document it was read from.'
                : 'The page of the citing document this was read from. No section is named for it — the page is exact regardless.'
            }
          >
            {[t.section, t.page != null ? `p.${t.page}` : null].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      <div
        ref={quoteRef}
        className={`cg-edgecard-quote${ctx.sentence ? '' : ' cg-edgecard-quote-bib'}${
          open ? ' is-open' : ''
        }`}
        data-testid={`edgecard-quote-${ctx.id}`}
      >
        {quote ?? '—'}
      </div>
      {/* The hover card has `pointer-events: none`, so an expander drawn on it
          would be a control the pointer passes straight through — visible,
          styled, and dead. */}
      {clamped && interactive && (
        <button
          type="button"
          className="cg-edgecard-expand"
          data-testid={`edgecard-expand-${ctx.id}`}
          aria-expanded={open}
          data-tip={open ? 'Clamp this passage back to four lines.' : 'Show the whole passage.'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'show less' : 'show all'}
        </button>
      )}

      {/* The destination is THIS passage, so the control belongs to it. A single
          button per card could only ever open one of several passages, silently
          picking for the user.

          Rendered pressable ONLY when a jump can actually land. It used to be
          rendered unconditionally, so a passage the viewer's locator refuses to
          search for still offered "go to reference →" and then drew nothing.

          Drawn ONLY on the pinned card. The hover card follows the pointer and
          passes clicks through, so nothing on it can be reached — and an inert
          marker there would state "not locatable" about passages that are
          perfectly locatable, on the one card whose tooltip could never fire to
          say otherwise. A card that holds no controls is honest; a card full of
          dead ones is not. */}
      {!interactive ? null : locatable ? (
        <button
          type="button"
          className="cg-edgecard-goto"
          data-testid={`edgecard-goto-${ctx.id}`}
          data-reach="navigable"
          data-tip={`Open ${citingTitle} at this passage and highlight it.`}
          onClick={() => onOpenQuote?.(citingWorkId, quote as string)}
        >
          go to reference →
        </button>
      ) : (
        <div
          className="cg-edgecard-goto cg-edgecard-goto-inert"
          data-testid={`edgecard-goto-${ctx.id}`}
          data-reach="inert"
          aria-disabled="true"
          // Focusable, though it does nothing when focused. The REASON lives in
          // the tooltip, and the tooltip host raises it on `focusin` as well as
          // hover — so without a tab stop the only account of why this passage
          // cannot be opened is available to pointer users alone. It stays a div
          // rather than a disabled button because a disabled button receives no
          // pointer events either, and would lose the hover half as well.
          tabIndex={0}
          aria-label={`Not locatable. ${inertReason}`}
          data-tip={inertReason}
        >
          {/* A standalone glyph, not the combining enclosing-circle-backslash
              (U+20E0), which renders ON TOP of the following letter. */}
          <span aria-hidden="true">⊘</span> not locatable
        </div>
      )}
    </div>
  )
}

/**
 * The card's contents for one citation edge.
 *
 * `interactive` is false for the hover preview — that card follows the pointer,
 * so its buttons cannot be aimed at and must not offer themselves.
 */
export function EvidenceBody({
  edge,
  interactive,
  onOpenWork,
  onOpenQuote
}: {
  edge: CitationEdgeDTO
  interactive: boolean
  onOpenWork: (workId: number) => void
  /** Open a paper scrolled to the passage carrying this citation text. */
  onOpenQuote?: (workId: number, quote: string) => void
}): JSX.Element {
    // The head names BOTH SIDES of the citation and opens either. Below it sits
    // the one thing the corpus actually holds passages for: where the CITING
    // paper reaches for the cited one.
    //
    // The list simply LISTS those passages. There is no "first" occurrence and
    // no "other" group: a paper can cite another in the methods and again in the
    // discussion, and neither mention is subordinate to the other — promoting
    // one and calling the rest "more" invented a hierarchy the data does not
    // have. Nothing is sliced off; a long list scrolls.
    const citingCtxs = shownContexts(edge)
    return (
      <>
        <div className="cg-edgecard-heads">
          <div className="cg-edgecard-head-col">
            <div className="cg-edgecard-side mono">CITING</div>
            <button
              type="button"
              className="cg-edgecard-head-body"
              data-testid="edgecard-open-citing"
              disabled={!interactive}
              data-tip={interactive ? `Open ${plainText(edge.citing_title)}` : undefined}
              onClick={() => onOpenWork(edge.citing_work_id)}
            >
              <PaperThumb workId={edge.citing_work_id} title={edge.citing_title} />
              <span className="cg-edgecard-paper"><RichText text={edge.citing_title} /></span>
            </button>
          </div>
          {/* Points from the CITING paper to the CITED one, matching the column
              order beside it. A citation runs one way — the exchange glyph that
              was here read as a mutual relationship, which is the one thing this
              edge never is. Decorative: the CITING/CITED labels carry the
              meaning, so it is hidden from assistive tech rather than spoken as
              an arrow. */}
          <div className="cg-edgecard-swap" aria-hidden="true">
            <span>→</span>
          </div>
          <div className="cg-edgecard-head-col">
            <div className="cg-edgecard-side mono">CITED</div>
            <button
              type="button"
              className="cg-edgecard-head-body"
              data-testid="edgecard-open-cited"
              disabled={!interactive}
              data-tip={interactive ? `Open ${plainText(edge.cited_title)}` : undefined}
              onClick={() => onOpenWork(edge.cited_work_id)}
            >
              <PaperThumb workId={edge.cited_work_id} title={edge.cited_title} />
              <span className="cg-edgecard-paper"><RichText text={edge.cited_title} /></span>
            </button>
          </div>
        </div>

        {/* ONE column, of the CITING paper's passages.
            There was a second column for the cited paper's passages, and it was
            permanently empty with a pressable button under it: no producer fills
            `target_sentence` (see the type's own note — locating the passage a
            citance points AT is a separate, unsolved problem), so `citedCtxs`
            was always `[]` and the column always rendered its placeholder beside
            a control that could never fire. A column that cannot ever hold
            anything is not a feature waiting on data, it is a promise the app
            does not keep, so it is gone until something fills it. The heads
            above still name both papers and both open. */}
        <div className="cg-edgecard-list" data-testid="edgecard-citing-list">
          {citingCtxs.length === 0 ? (
            <div className="cg-edgecard-await">No citation context parsed yet</div>
          ) : (
            citingCtxs.map((c: CitationContextDTO) => (
              <OccurrenceRow
                key={c.id}
                ctx={c}
                citingTitle={edge.citing_title}
                citingWorkId={edge.citing_work_id}
                interactive={interactive}
                onOpenQuote={onOpenQuote}
              />
            ))
          )}
        </div>
      </>
    )
}
