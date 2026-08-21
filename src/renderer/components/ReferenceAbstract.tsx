import { useCallback, useState } from 'react'
import type { ReferenceAbstractDTO, ReferenceAbstractStateDTO } from '@shared/contract'
import { Modal } from './ui'
import { RichText, plainText } from './RichText'

/**
 * "Read abstract" for a paper this corpus CITES but does not hold, and the
 * panel it opens.
 *
 * ONE COMPONENT FOR ALL THREE PLACES — the References tree, the connectome's
 * unknown-reference list and the Paper screen's unresolved rows — because the
 * three states below are a reading of `reference_abstract.outcome`, and three
 * copies of that reading is three chances for one of them to tell the user an
 * index answered when it never did.
 *
 * THE LABEL CARRIES THE STATE, and there are exactly three:
 *
 *   Read abstract     an abstract is stored          — pressable
 *   Getting abstract… nothing has asked yet, or the
 *                     index could not be reached     — inert
 *   No abstract found an index answered and holds
 *                     none, or none could be trusted — inert
 *
 * 'unreachable' SITS WITH THE FIRST GROUP, and this is the distinction the
 * whole feature turns on. "The index could not be reached" is a fact about our
 * network; "this paper has no abstract" is a claim about the paper. Labelling a
 * failed request "No abstract found" makes the second claim on the strength of
 * the first, and the user stops looking for something that is very likely there.
 * `reference_abstract` exists to keep those apart — the header of
 * `main/references/store.ts` says so — and the button must not re-fuse them.
 */

/** What the button says, and whether it can be pressed. */
interface AbstractAffordance {
  label: string
  enabled: boolean
  tip: string
  /** For styling: `pending` and `none` must not look alike either. */
  tone: 'ready' | 'pending' | 'none'
}

/**
 * An abstract's paragraphs, as the index actually stored them.
 *
 * Crossref and OpenAlex both hand back plain text with the markup already
 * stripped, so the only structure left is whitespace — a blank line between
 * blocks in some records, a single newline in others, and nothing at all in the
 * majority. Splitting on a run of newlines covers all three: a record with no
 * newlines yields one paragraph and reads exactly as before.
 *
 * Blank entries are dropped so a trailing newline cannot render an empty
 * paragraph, which shows up as an unexplained gap at the end of the panel.
 */
export function abstractParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export function abstractAffordance(state: ReferenceAbstractStateDTO): AbstractAffordance {
  if (state.has_abstract) {
    return {
      label: 'Read abstract',
      enabled: true,
      tip:
        state.source === null
          ? 'Read the abstract fetched for this reference.'
          : `Read the abstract ${state.source === 'crossref' ? 'Crossref' : 'OpenAlex'} returned for this reference.`,
      tone: 'ready'
    }
  }
  switch (state.outcome) {
    // No row at all: the sweep has not reached this reference. Not "absent" —
    // nothing has asked, so nothing has answered, and the TIP says so. Three
    // labels are what this control offers; the five outcomes underneath them
    // are told apart in the tooltip rather than by inventing more.
    case null:
      return {
        label: 'Getting abstract…',
        enabled: false,
        tip: 'No abstract has been fetched for this reference yet. Abstracts are fetched with the rest of this paper’s bibliography.',
        tone: 'pending'
      }
    case 'unreachable':
      return {
        label: 'Getting abstract…',
        enabled: false,
        tip: 'The index could not be reached the last time this reference was looked up, so nothing is known about whether it has an abstract. It will be asked again.',
        tone: 'pending'
      }
    case 'absent':
      return {
        label: 'No abstract found',
        enabled: false,
        tip: 'The index answered and holds no abstract for this paper — this is about the paper, not about our connection.',
        tone: 'none'
      }
    case 'ambiguous':
      return {
        label: 'No abstract found',
        enabled: false,
        tip: 'Several records matched what this reference prints and none could be told apart from the others, so no abstract was taken — attaching the wrong paper’s would be worse than having none.',
        tone: 'none'
      }
    // Nothing was ever asked, so nothing answered. The shared label cannot say
    // that, which is exactly why the tip must: it names OUR shortfall rather
    // than making a claim about the paper, and it is the one case the user can
    // act on, by fixing what the entry prints.
    case 'nothing-to-ask-with':
      return {
        label: 'No abstract found',
        enabled: false,
        tip: 'This entry prints no DOI and no title an index could be asked with, so no abstract could be looked up. Nothing has been asked about this paper.',
        tone: 'none'
      }
    // `outcome` is 'found' and yet no abstract is stored. Reported as the
    // shortfall it is rather than offering a button that opens nothing.
    default:
      return {
        label: 'No abstract found',
        enabled: false,
        tip: 'The index reported an abstract for this reference but none was stored.',
        tone: 'none'
      }
  }
}

/**
 * The button plus its panel.
 *
 * `className` lets each site place it in its own layout without this component
 * knowing anything about those layouts; the base `btn` class is always applied
 * here, because `btn-secondary` alone renders a raw browser button.
 *
 * DISABLED VIA `aria-disabled`, NOT `disabled`. A `disabled` button is removed
 * from the accessibility tree and — more to the point here — stops firing the
 * pointer events that show its tooltip, so the reason it cannot be pressed
 * would be readable only by the users who did not need it.
 */
export function ReadAbstractButton({
  state,
  /** The printed title, so the panel can show what the fetched record differs from. */
  printedTitle,
  className,
  testid
}: {
  state: ReferenceAbstractStateDTO
  printedTitle: string | null
  className?: string
  testid?: string
}): JSX.Element {
  const aff = abstractAffordance(state)
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState<ReferenceAbstractDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const openPanel = useCallback(async (): Promise<void> => {
    if (!aff.enabled) return
    setOpen(true)
    setError(null)
    setLoading(true)
    try {
      setRow(await window.api.getReferenceAbstract(state.unresolved_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [aff.enabled, state.unresolved_id])

  return (
    <>
      <button
        type="button"
        className={`btn btn-secondary ra-btn ra-btn-${aff.tone}${open ? ' is-open' : ''}${
          loading ? ' is-busy' : ''
        }${className ? ` ${className}` : ''}`}
        data-testid={testid}
        aria-disabled={!aff.enabled || undefined}
        aria-busy={loading || undefined}
        aria-expanded={aff.enabled ? open : undefined}
        data-tip={aff.tip}
        onClick={() => void openPanel()}
      >
        {loading && <span className="ra-spinner" aria-hidden="true" />}
        {aff.label}
      </button>
      {open && (
        <Modal
          title="Abstract"
          testid={testid ? `${testid}-modal` : 'reference-abstract-modal'}
          onClose={() => setOpen(false)}
        >
          <div className="ra-modal">
            {/* WHAT THE BIBLIOGRAPHY PRINTED, first. The reader came here from
                a reference; the fetched record is the second thing, and it is a
                claim about the first. */}
            {printedTitle !== null && (
              <div className="ra-printed">
                <span className="ra-label">Cited as</span>
                <span className="ra-printed-title">
                  <RichText text={printedTitle} />
                </span>
              </div>
            )}
            {/* THE MATCH, and only when it says something. Identical titles are
                the normal case and a chip repeating the line above it is HARD
                RULE 0.6's badge-on-everything. A DIFFERENT title is the whole
                reason this is shown: it means the index matched this reference
                to a paper the bibliography did not name, and the abstract below
                may belong to something else. */}
            {row?.matched_title != null &&
              (printedTitle === null || !sameTitle(row.matched_title, printedTitle)) && (
                <div className="ra-matched" data-testid="reference-abstract-matched">
                  <span className="badge badge-warn">matched to a different title</span>
                  <span className="ra-matched-title">
                    <RichText text={row.matched_title} />
                  </span>
                </div>
              )}

            {loading && <div className="ra-loading">Reading…</div>}
            {error !== null && (
              <div className="ra-error" role="alert">
                {error}
              </div>
            )}
            {!loading && error === null && (
              <>
                {row?.abstract != null && row.abstract.trim().length > 0 ? (
                  // ONE PARAGRAPH PER BLOCK, not one <p> for the whole thing.
                  // 69 of this corpus's 395 abstracts carry newlines — many are
                  // structured (Background / Methods / Results) — and collapsing
                  // them into a single block ran those sections together into a
                  // wall of text with no way to see where one ended.
                  <div className="ra-text">
                    {abstractParagraphs(row.abstract).map((para, i) => (
                      <p key={i}>
                        <RichText text={para} />
                      </p>
                    ))}
                  </div>
                ) : (
                  <div className="ra-none">
                    No abstract is stored for this reference after all — it may have been
                    re-fetched since this list was drawn.
                  </div>
                )}
                {/* WHOSE CLAIM THIS IS. An abstract shown with no source reads
                    as the corpus's own, and the two indexes disagree often
                    enough that the reader is entitled to know which answered. */}
                <div className="ra-prov mono">
                  {[
                    row?.source === 'crossref'
                      ? 'from Crossref'
                      : row?.source === 'openalex'
                        ? 'from OpenAlex'
                        : 'source not recorded',
                    row?.doi != null ? row.doi : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}

/**
 * Whether two titles are the same paper's, for the purpose of NOT warning.
 *
 * Deliberately forgiving: markup, case, punctuation and spacing differ between
 * a bibliography line and an index record for the same paper constantly, and a
 * warning that fires on every reference is a warning nobody reads by the time a
 * real mismatch appears.
 */
function sameTitle(a: string, b: string): boolean {
  const fold = (s: string): string =>
    plainText(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  return fold(a) === fold(b)
}
