// The "By meaning" half of the in-document find bar: a short list of the
// passages in THIS paper whose vectors sit closest to what the reader typed.
//
// It is a different instrument from verbatim find, and the UI has to read that
// way. Verbatim answers "where does this string occur" and cycles through every
// occurrence; this answers "which passages are about this", returns a fixed
// reading budget of ten, and cannot promise the reader's words appear at all.
// So there is no "3 of 17" and no next/previous: there is a list, each row
// naming the passage that is the reason it is on the list.
//
// Two honesty rules govern everything here, both inherited:
//
//   1. A row that offers to jump MUST land somewhere. Every candidate is probed
//      against the viewer's text index before it is offered, and one that
//      cannot be located is rendered visibly inert rather than left to fail
//      under the pointer.
//   2. A cosine is not a confidence. It is shown as a cosine, to two decimals,
//      beside an ordinal band — never as a percentage, and never as a bar that
//      would imply a scale from nothing to certainty.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { SemanticHitDTO, SemanticSearchResultDTO } from '@shared/contract'
import type { AsyncState } from '../lib/useAsync'
import type { PdfFindApi, PdfTextState } from './PdfDocView'
import { fmtSimilarity, similarityBand, textSourceMeta } from '../lib/format'
import { OCR_LOW_CONFIDENCE } from '@shared/contract'

/**
 * How many passages the dropdown asks for.
 *
 * The user's number. It is a READING BUDGET, not a count of what matched — the
 * list says so out loud when it is full, because a list of ten that looks
 * exhaustive is the way this feature lies.
 */
export const FIND_MEANING_K = 10

/**
 * Whether a candidate can be jumped to.
 *
 * `checking` is a genuine WAIT — the page images are still rasterizing, so the
 * text index covers a prefix of the document and "not found" about a passage on
 * a later page would be an answer that silently reverses itself a second later.
 * `inert` is settled: probed against a complete index and not there.
 */
type Reach = 'checking' | 'navigable' | 'inert'

/** What the screen needs back when a candidate is chosen. */
export interface MeaningPick {
  chunkId: number
  /** The passage verbatim — the needle the viewer locates. */
  text: string
  /** Where the probe FOUND it, handed to the viewer as `PdfHighlight.frac`. */
  frac: number
  page: number | null
}

/**
 * The DOM id of one candidate row.
 *
 * Exported because the INPUT owns the keyboard cursor and must name the option
 * it is on via `aria-activedescendant` — a visual cursor that nothing announces
 * leaves a screen-reader user arrowing through silence.
 */
export const meaningRowId = (chunkId: number): string => `pdf-find-meaning-row-${chunkId}`

/** The id of the listbox, shared with the input's `aria-controls`. */
export const MEANING_LIST_ID = 'pdf-find-meaning-list'

function snippet(text: string, max = 190): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

export function FindByMeaning({
  state,
  query,
  findApi,
  findEpoch,
  textState,
  pickedChunkId,
  unanchored,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onReachChange
}: {
  state: AsyncState<SemanticSearchResultDTO | null>
  query: string
  findApi: PdfFindApi | null
  /** Bumped whenever the text index is rebuilt, invalidating every probe. */
  findEpoch: number
  textState: PdfTextState
  pickedChunkId: number | null
  /**
   * Chunks the VIEWER refused to draw.
   *
   * Outranks the probe: the probe predicts from the text index, this is what
   * the locator actually did. A row the probe found and the viewer would refuse
   * must go inert here, or it goes on offering a jump that draws nothing.
   */
  unanchored: Set<number>
  /** Keyboard cursor, owned by the input so arrow keys can drive this list. */
  activeIndex: number
  onActiveIndexChange: (i: number) => void
  onPick: (pick: MeaningPick) => void
  /** Which chunk ids are jumpable, so the input's Enter cannot pick a dud. */
  onReachChange: (byChunk: Map<number, number>) => void
}): JSX.Element {
  const res = state.data
  const hits = useMemo<SemanticHitDTO[]>(() => res?.hits ?? [], [res])

  // ---- reachability: one index build answers every candidate ----
  // Batched for the same reason the citation list batches: `find` rebuilds the
  // whole canonical text index per call, so ten calls would walk every span in
  // the document ten times while the reader waits to see which rows are live.
  const [reach, setReach] = useState<{ epoch: number; ok: Map<number, number> } | null>(null)
  useEffect(() => {
    if (!findApi || textState !== 'ready' || hits.length === 0) {
      setReach(null)
      onReachChange(new Map())
      return
    }
    // The stored page is a HINT for choosing between repeated occurrences, never
    // an anchor: it addresses the canonical document text, which is a different
    // coordinate space from the rendered layer.
    const probes = findApi.probe(hits.map((h) => ({ text: h.text, near: h.page })))
    const ok = new Map<number, number>()
    hits.forEach((h, i) => {
      const frac = probes[i]
      // A chunk the viewer has already refused is left OUT of the map, not
      // merely styled as inert: the map is what the input's Enter chooses from,
      // so keeping it would let the keyboard pick a row the pointer cannot.
      if (frac !== null && frac !== undefined && !unanchored.has(h.chunk_id)) {
        ok.set(h.chunk_id, frac)
      }
    })
    setReach({ epoch: findEpoch, ok })
    onReachChange(ok)
  }, [findApi, findEpoch, hits, textState, unanchored, onReachChange])

  // A settled NO for the whole list, distinct from a per-row one: there is no
  // document to jump INTO. Every row is a real passage of the paper — the
  // vectors were made from its text — so they are still worth reading here, but
  // none of them can be shown in a viewer that has nothing rendered.
  const noDocument = textState === 'unavailable' || (!findApi && textState !== 'pending')

  const reachOf = (h: SemanticHitDTO): Reach => {
    if (noDocument) return 'inert'
    // The viewer already tried this one and drew nothing. Its verdict outranks
    // the probe's prediction.
    if (unanchored.has(h.chunk_id)) return 'inert'
    // The index was rebuilt (zoom, re-render) and this verdict predates it.
    // Reporting it would let a row claim reachability from an index that is gone.
    if (!reach || reach.epoch !== findEpoch) return 'checking'
    return reach.ok.has(h.chunk_id) ? 'navigable' : 'inert'
  }

  // Keep the keyboard cursor in view when arrow keys move it past the fold.
  const listRef = useRef<HTMLUListElement | null>(null)
  // Keep the keyboard cursor in view when arrow keys move it past the fold.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (state.loading) {
    return (
      <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
        <div className="pv-meaning-status" role="status">
          <span className="pv-meaning-spark" aria-hidden="true" />
          Reading your phrase and comparing it with every embedded passage in this paper…
        </div>
      </div>
    )
  }

  // A thrown failure is a defect, not a state the reader can act on — but it
  // still has to be legible rather than an empty list that reads as "nothing
  // here matches".
  if (state.error) {
    return (
      <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
        <p className="pv-meaning-note pv-meaning-note-bad" role="alert">
          The meaning search could not run. {state.error}
        </p>
      </div>
    )
  }

  if (query.trim().length === 0) {
    return (
      <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
        <p className="pv-meaning-note">
          Describe what you are looking for. A meaning search compares your sentence with
          whole passages, so a question or a phrase works far better than a single word.
        </p>
      </div>
    )
  }

  // States the USER can act on — this paper not embedded, no model packaged, a
  // model swapped under the existing vectors — arrive as a sentence rather than
  // as an empty list. The distinction matters more here than anywhere: an empty
  // dropdown reads as "nothing in this paper is about that", which about an
  // unembedded paper is a confident statement the app is in no position to make.
  if (res && res.error !== null) {
    return (
      <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
        <p className="pv-meaning-note pv-meaning-note-bad" data-testid="pdf-find-meaning-unavailable">
          {res.error}
        </p>
        <p className="pv-meaning-note">
          Verbatim search still works on this paper — press Tab to switch back to it.
        </p>
      </div>
    )
  }

  if (hits.length === 0) {
    return (
      <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
        <p className="pv-meaning-note" data-testid="pdf-find-meaning-empty">
          No passage in this paper came close to that. The paper IS embedded, so this is
          an answer rather than a gap — try describing the idea in a fuller sentence.
        </p>
      </div>
    )
  }

  const staleShown = hits.some((h) => h.stale_vector)

  return (
    <div className="pv-meaning-panel" data-testid="pdf-find-meaning">
      <div className="pv-meaning-head">
        <span className="pv-meaning-head-count">
          {/* "The closest N", never a bare count: a count of what arrived reads
              as a count of what matched, and ten is a reading budget. When the
              list is SHORT it is short because the paper holds no more, so the
              wording says that instead. */}
          {hits.length === FIND_MEANING_K
            ? `The closest ${FIND_MEANING_K} passages`
            : `Every close passage (${hits.length})`}
        </span>
        <span
          className="pv-meaning-head-hint"
          data-tip="This search matches whole passages by meaning, so the words you typed may not appear in the result at all."
        >
          passages, not phrases
        </span>
      </div>
      <ul
        className="pv-meaning-list"
        id={MEANING_LIST_ID}
        ref={listRef}
        role="listbox"
        aria-label="Passages closest in meaning"
      >
        {hits.map((h, i) => {
          const r = reachOf(h)
          const band = similarityBand(h.score)
          const ts = textSourceMeta(h.text_source, h.text_confidence, OCR_LOW_CONFIDENCE)
          const picked = pickedChunkId === h.chunk_id
          return (
            <li key={h.chunk_id} role="presentation">
              <button
                type="button"
                id={meaningRowId(h.chunk_id)}
                data-idx={i}
                className="pv-meaning-row"
                data-reach={r}
                data-picked={picked ? '1' : undefined}
                data-cursor={i === activeIndex ? '1' : undefined}
                data-testid={`pdf-find-meaning-row-${h.chunk_id}`}
                role="option"
                aria-selected={picked}
                // A row that cannot be located does not merely look different:
                // pressing it does nothing. A control that responds and then
                // draws nothing is the failure this rule exists to forbid.
                //
                // `aria-disabled` and a guarded handler rather than the
                // `disabled` attribute: a truly disabled button receives no
                // pointer events and cannot be focused, so its `data-tip` can
                // never be shown and a keyboard user can never reach the
                // explanation at all. The rule is that a refusal must EXPLAIN
                // itself, and `disabled` is the one way to make that
                // impossible. Assistive tech is told it is unavailable; the
                // press is refused below.
                aria-disabled={r !== 'navigable'}
                // A refusal must say WHICH refusal it is. "No PDF is being
                // shown" and "this passage is not in the PDF that is" are
                // different problems with different remedies, and one tooltip
                // for both would send the reader after the wrong one.
                data-tip={
                  r === 'checking'
                    ? 'Still working out where this passage sits on the page — check back in a moment.'
                    : r === 'inert'
                      ? noDocument
                        ? 'No document is being displayed, so there is nowhere to jump to. The passage itself is quoted above, verbatim from the paper.'
                        : 'This passage could not be located in the rendered document, so there is nowhere to jump to. It is usually a passage the text layer and the page image disagree about.'
                      : undefined
                }
                onMouseEnter={() => onActiveIndexChange(i)}
                onClick={() => {
                  if (r !== 'navigable') return
                  const frac = reach?.ok.get(h.chunk_id)
                  // Belt and braces: the map is the authority on where a row
                  // goes, and a row with no entry in it has nowhere to go.
                  if (frac === undefined) return
                  onPick({ chunkId: h.chunk_id, text: h.text, frac, page: h.page })
                }}
              >
                <span className="pv-meaning-rank mono">{i + 1}</span>
                <span className="pv-meaning-main">
                  <span className="pv-meaning-quote">{snippet(h.text)}</span>
                  <span className="pv-meaning-meta">
                    <span className="mono">{h.page !== null ? `p.${h.page}` : 'page unknown'}</span>
                    {h.section && <span className="pv-meaning-section">{h.section}</span>}
                    {r === 'checking' && <span className="pv-meaning-reach">locating…</span>}
                    {r === 'inert' && (
                      <span className="pv-meaning-reach pv-meaning-reach-bad">
                        {noDocument ? 'no document shown' : 'not locatable'}
                      </span>
                    )}
                    {h.low_confidence && (
                      <span className="badge badge-warn" data-tip="Only part of this passage was compared — it was very short, or too long to read in full — so the match is less reliable than the quote suggests.">
                        partial passage
                      </span>
                    )}
                    {ts && h.text_source !== 'pdf-text-layer' && (
                      <span className={`badge badge-${ts.cls}`} data-tip={ts.hint}>
                        {ts.label}
                      </span>
                    )}
                    {/* The k-NN does not filter on config_hash, so a vector
                        written under older settings ranks here looking exactly
                        like a current one. Said per row, because a note in the
                        header cannot say WHICH row it applies to. */}
                    {h.stale_vector && (
                      <span className="badge badge-danger" data-tip="This passage was indexed with older settings, so the match may be off. It refreshes next time the paper is re-indexed.">
                        outdated vector
                      </span>
                    )}
                  </span>
                </span>
                <span className="pv-meaning-side">
                  <span
                    className="pv-meaning-score mono"
                    data-tip="How close this passage is in meaning to what you typed, from -1 to 1. It is a closeness score, not a confidence that the passage answers your question."
                  >
                    {fmtSimilarity(h.score)}
                  </span>
                  <span className={`badge badge-${band.cls}`} data-tip={band.hint}>
                    {band.label}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {staleShown && (
        <p className="pv-meaning-note pv-meaning-note-bad">
          Some passages above were indexed under settings the app no longer uses, so their
          ranking reflects an older reading of this paper.
        </p>
      )}
    </div>
  )
}
