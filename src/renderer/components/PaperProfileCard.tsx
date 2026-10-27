// The card shown when a paper is clicked in the reference tree.
//
// The question in front of someone who has just clicked a node in a citation
// graph is "what IS this paper?", so the card answers that in place — and
// carries the two verbs (read it, harvest its missing citations) alongside,
// since both are reachable from the same moment.
//
// It reads the summaries rather than generating them: opening a card must never
// start a model run, and a card that quietly cost money to look at would be a
// card nobody dares click. Where a summary has not been written the card says
// which reason applies, since they need different remedies.

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { WorkSummaryDTO } from '@shared/contract'
import { PaperThumb } from './PaperThumb'
import { useSummaryVersion } from '../lib/summaries'
import { RichText } from './RichText'

/**
 * One summary, in the state it is actually in.
 *
 * The non-ready states are NOT collapsed into "nothing here": they mean
 * different things and send the reader to different places. `failed` invites a
 * retry, `no-source` needs a PDF, `text-unreadable` needs the text extracted
 * again, `no-dossier` needs the topic dossier built, `dossier-self-only` needs a
 * SECOND reference paper, and `missing` just needs someone to press the button.
 * Flattening them would be the same as printing an empty box.
 */
function SummaryWidget({
  label,
  hint,
  summary,
  loading,
  unread
}: {
  label: string
  hint: string
  summary: WorkSummaryDTO | null
  loading: boolean
  /**
   * The read of this summary FAILED, so nothing is known about it.
   *
   * Distinct from `summary === null`, which means the read succeeded and found
   * none. Falling into "Not written yet" on a failed read invites the user to
   * spend a model run rewriting a summary they already have, and then to
   * believe the second one replaced nothing.
   */
  unread: boolean
}): JSX.Element {
  const state = summary?.state ?? 'missing'
  return (
    <section className="rt-profile-sum" data-testid={`profile-summary-${label.toLowerCase()}`}>
      <div className="rt-profile-sum-head">
        <span className="rt-profile-sum-label mono">{label}</span>
        {/* Only when it was NOT the whole paper — see the badge rule in
            CLAUDE.md. "full text" is the expected case and saying so on every
            card costs the real warning its force. */}
        {state === 'ready' &&
          summary?.source_scope != null &&
          !summary.source_scope.startsWith('full text') && (
            <span
              className="badge badge-warn"
              data-tip={`Written from ${summary.source_scope} — not the whole paper, so it covers far less than the work does.`}
            >
              {summary.source_scope}
            </span>
          )}
      </div>

      {loading ? (
        <div className="rt-profile-sum-note">Reading…</div>
      ) : unread ? (
        <div className="rt-profile-sum-note is-unread" role="alert">
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 2.6L18 16.6H2z" />
            <path d="M10 8v3.6" />
            <path d="M10 14.1v.1" />
          </svg>
          This summary could not be read, so there may be one already written.
          Close and reopen this paper to try again.
        </div>
      ) : state === 'ready' && summary?.body ? (
        // Paragraphs split on the blank line the prompt asks for and NOTHING
        // else: no markdown is interpreted, so a model that emits syntax shows
        // the characters rather than gaining typographic authority.
        <div className="rt-profile-sum-body">
          {summary.body
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p, i) => (
              <p key={i}>{p}</p>
            ))}
        </div>
      ) : (
        <div
          className={`rt-profile-sum-note${state === 'text-unreadable' ? ' is-damaged' : ''}`}
        >
          {state === 'failed'
            ? 'The last attempt produced nothing usable.'
            : state === 'text-unreadable'
              ? // The text is HERE and damaged, which is not the same as absent
                // — and the remedy is the opposite one. Without this branch it
                // fell through to "Not written yet", which invites a press that
                // will refuse and names no fix.
                'This paper’s text was extracted but cannot be read back. Extract it again from the Queue screen.'
              : state === 'no-source'
                ? 'This paper has no text yet — only its title.'
                : state === 'no-dossier'
                  ? 'This project has no project context yet, so there is nothing to read the paper against.'
                  : state === 'dossier-self-only'
                    ? 'The whole project context comes from this paper, so there is nothing else to read it against.'
                    : `Not written yet. ${hint}`}
        </div>
      )}
    </section>
  )
}

/**
 * The profile card for one paper in the tree.
 *
 * Both summaries are fetched together on open — two reads of one paper, not
 * fifty, so there is nothing to batch and the pair arrives in one round trip.
 */
export function PaperProfileCard({
  workId,
  projectId,
  title,
  hiddenUnknowns,
  onRead,
  onSelectUnknowns
}: {
  workId: number
  projectId: number
  title: string
  /**
   * Cited-but-absent papers currently switched OFF, so the select action can
   * say that choosing it will bring them back rather than appearing to do
   * nothing.
   */
  hiddenUnknowns: number
  onRead: () => void
  onSelectUnknowns: () => void
}): JSX.Element {
  const [general, setGeneral] = useState<WorkSummaryDTO | null>(null)
  const [project, setProject] = useState<WorkSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  /** The pair could not be read at all — see `SummaryWidget`'s `unread`. */
  const [unread, setUnread] = useState(false)
  // This card had NO refresh path: it read once when it opened and then showed
  // whatever it found for as long as it stayed open, so a summary written from
  // the paper itself never appeared here. Depending on the store fixes that
  // without the writer needing to know this card exists.
  const summaryVersion = useSummaryVersion()

  useEffect(() => {
    let cancelled = false
    // Only the FIRST read blanks the widgets. A refresh from the version
    // counter usually returns what is already shown, and flashing "Reading…"
    // over prose each time a summary is written elsewhere would make an
    // unrelated action look like it broke this card.
    setLoading(general === null && project === null)
    Promise.all([
      window.api.getWorkSummary({ workId, projectId, kind: 'general' }),
      window.api.getWorkSummary({ workId, projectId, kind: 'project' })
    ])
      .then(([g, p]) => {
        if (cancelled) return
        setGeneral(g)
        setProject(p)
        setUnread(false)
      })
      .catch(() => {
        if (cancelled) return
        setGeneral(null)
        setProject(null)
        setUnread(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workId, projectId, summaryVersion])

  return (
    <div className="rt-profile" data-testid="references-profile-card">
      {/* Two columns: the page-1 preview down the LEFT, everything about the
          paper stacked to its right. Large rather than the 34px chip the
          evidence card uses — this is the card you open to decide whether to
          read the paper, and at that size the first page is legible enough to
          be evidence in that decision rather than a decoration.

          It draws its own dashed "?" frame when the work has no PDF, which is
          a different claim from "still loading", and the raster is cached
          module-wide so reopening the same paper does not re-rasterise. */}
      <div className="rt-profile-cols">
        <div className="rt-profile-preview">
          <PaperThumb workId={workId} title={title} size="lg" />
        </div>

        <div className="rt-profile-main">
          <h3 className="rt-profile-title"><RichText text={title} /></h3>

      <div className="rt-profile-sums">
        <SummaryWidget
          label="General"
          hint="It describes what the paper did and found, for any reader."
          summary={general}
          loading={loading}
          unread={unread}
        />
        <SummaryWidget
          label="Project"
          hint="It says what the paper means for this project specifically."
          summary={project}
          loading={loading}
          unread={unread}
        />
      </div>

      <div className="rt-profile-actions">
        <button
          type="button"
          className="btn btn-primary rt-profile-btn"
          data-testid="references-profile-read"
          autoFocus
          onClick={onRead}
        >
          Read the paper
        </button>
        <button
          type="button"
          className="btn btn-secondary rt-profile-btn"
          data-testid="references-profile-select-unknowns"
          data-tip={
            hiddenUnknowns > 0
              ? 'Papers you do not have are hidden — choosing this shows them again so they can be picked.'
              : 'Select the references this paper cites that you do not have yet, so you can fetch them together.'
          }
          onClick={onSelectUnknowns}
        >
          {hiddenUnknowns > 0 ? 'Show & select cited unknowns' : 'Select cited unknowns'}
        </button>
      </div>
        </div>
      </div>
    </div>
  )
}
