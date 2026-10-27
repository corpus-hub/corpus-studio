// The two summaries of a paper: the buttons that open them, and the modal that
// shows the prose.
//
// ONE component pair for every place the pair is offered (the Paper header, a
// Ranking row) so the labels, the wording and the state machine cannot drift
// apart — the same reasoning `DossierToggle` records, and the same failure it
// was created to fix.
//
// FETCHED ON OPEN, never on mount. Ranking renders 50 rows a page and each row
// carries both buttons; loading eagerly would fire 100 IPC calls to render a
// list in which the user will open at most one summary. The cost of the lazy
// read is one spinner inside a modal the user just asked for, which is where a
// wait belongs.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { SummaryKind, WorkSummaryDTO } from '@shared/contract'
import { Modal } from './ui'
import { fmtTime } from '../lib/format'
import { useShowProvenance } from '../lib/prefs'
import { notifySummaryWritten, useSummaryVersion } from '../lib/summaries'
import { RichText, plainText } from './RichText'

/**
 * What each summary IS, in the words the reader needs before trusting it.
 *
 * The distinction is the app's central ontology rule and it is invisible in the
 * prose itself: both read like fluent summaries of the same paper. So it is
 * stated on the button, in the modal title, and in the modal's own subtitle —
 * a reader who opens the wrong one should discover that from the screen, not
 * from noticing the text mentions a project they are not in.
 */
const KIND_META: Record<
  SummaryKind,
  { label: string; short: string; title: string; tip: string; blurb: string }
> = {
  general: {
    label: 'General summary',
    // Dense-row label. The word "summary" is carried by the shared icon and by
    // the modal that opens, so repeating it twice per row costs width the row
    // does not have — while `label` stays the accessible name, so a screen
    // reader still hears the unabbreviated thing.
    short: 'General',
    title: 'General summary',
    tip: 'What this paper did and found, described to any scientist. Written once and shared by every project that holds this paper.',
    blurb:
      'What this paper did and found, independent of any project. The same text is shown in every project that holds this paper.'
  },
  project: {
    label: 'Project summary',
    short: 'Project',
    title: 'Project summary',
    tip: 'What this paper means for THIS project, read against its project context. Belongs to this project alone.',
    blurb:
      'What this paper means for this project, read against its project context. It belongs to this project and is not shown in any other.'
  }
}

/**
 * The prose, as paragraphs.
 *
 * Split on the blank line the prompt asks for and NOTHING else: no markdown is
 * interpreted, so a model that emits `**bold**` or a `## heading` shows those
 * characters instead of silently gaining typographic authority the writing was
 * never granted. Whitespace-only fragments are dropped so a stray triple
 * newline cannot render as an empty paragraph.
 */
function Prose({ body }: { body: string }): JSX.Element {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  return (
    <div className="sum-prose" data-testid="summary-prose">
      {paras.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  )
}

/**
 * The modal. Owns the read, the write, and every state between them.
 *
 * States, all visually distinct and all reachable: loading · ready ·
 * missing (never written) · failed (a run exists but produced no prose) ·
 * error (the read or the write threw, including "no text" and "no dossier",
 * which are refusals with actionable messages rather than crashes) ·
 * generating (a model is running).
 */
function SummaryModal({
  workId,
  projectId,
  kind,
  title,
  onClose
}: {
  workId: number
  projectId: number
  kind: SummaryKind
  /** The paper's title, for the modal heading and the accessible name. */
  title: string
  onClose: () => void
}): JSX.Element {
  const meta = KIND_META[kind]
  const showProvenance = useShowProvenance()
  // Re-reads when a summary is written ANYWHERE — including by the other kind's
  // modal, or by a second window. Without it, a modal left open while the same
  // paper was summarised elsewhere would keep showing the superseded prose.
  const summaryVersion = useSummaryVersion()

  const [summary, setSummary] = useState<WorkSummaryDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Set when the modal goes away, and consulted by the write below: a model
  // call runs for tens of seconds and the user is free to close the modal while
  // it does (the run completes in main regardless), so without this the
  // resolution lands on a component that no longer exists.
  const goneRef = useRef(false)
  useEffect(() => {
    goneRef.current = false
    return () => {
      goneRef.current = true
    }
  }, [])

  // The read runs when the modal mounts, and again whenever a summary is
  // written anywhere. `useAsync` is not used because this view also WRITES, and
  // the two paths must share one `summary` so freshly generated prose replaces
  // the old without a second round trip.
  useEffect(() => {
    let cancelled = false
    // `loading` — which blanks the pane — is set ONLY for the first read of a
    // given summary. A refresh triggered by the version counter is a
    // correctness check that almost always returns what is already on screen,
    // and flashing "Loading…" over prose the reader is mid-sentence through
    // would make every write elsewhere in the app feel like a fault here.
    // `setSummary` below swaps the text when it genuinely differs.
    setLoading(summary === null)
    setError(null)
    window.api
      .getWorkSummary({ workId, projectId, kind })
      .then((s) => {
        if (!cancelled) setSummary(s)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workId, projectId, kind, summaryVersion])

  const generate = useCallback(() => {
    setGenerating(true)
    setError(null)
    window.api
      .generateWorkSummary({ workId, projectId, kind })
      .then((s) => {
        if (!goneRef.current) setSummary(s)
        // Announced even if the modal has since closed: the write landed, and
        // every list behind it is now stale whether or not anyone is watching.
        //
        // Through the STORE, so this reaches surfaces the modal has never heard
        // of. Main broadcasts the same signal to every window; a double bump
        // costs one refetch and is cheaper than a screen that missed one.
        if (s.state === 'ready') notifySummaryWritten()
      })
      .catch((e: unknown) => {
        if (!goneRef.current) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!goneRef.current) setGenerating(false)
      })
  }, [workId, projectId, kind])

  const state = summary?.state ?? 'missing'
  const busy = loading || generating
  // The two ways a summary can fall short of the whole paper. Named here so the
  // badge row can be absent entirely in the ordinary case rather than rendering
  // an empty container. `partialSource` is every scope that is not the whole
  // work — an abstract, a supplementary file, text of unrecorded extent — since
  // each shortchanges the reader in the same way and none of them shows in the
  // prose.
  const partialSource =
    summary?.source_scope != null && !summary.source_scope.startsWith('full text')
  const cutShort = summary?.run?.verifier_result === 'partial'
  // A refusal is not a thing to retry: pressing the button would come straight
  // back with the same answer. The button stays visible and focusable (see the
  // aria-disabled note below) so its tooltip can say what to do instead.
  const blocked =
    state === 'no-source' ||
    state === 'no-dossier' ||
    state === 'dossier-self-only' ||
    state === 'text-unreadable'

  // Every state the button can be in, each saying what pressing it would do or
  // why it would not. A lookup rather than a nested ternary: the chain had grown
  // six deep and silently had no branch for `failed`, so the one state that most
  // needs explaining fell through to "Run a model over this paper" while the
  // body directly above said the last attempt had failed.
  const STATE_TIP: Record<string, string> = {
    'no-source': 'There is no text to summarise yet — add this paper’s PDF or abstract first.',
    'no-dossier':
      'Build this project’s context first — without it there is nothing to read the paper against.',
    'dossier-self-only':
      'This paper is the only source of the project context, so it would be read against itself. Mark another paper as a reference first.',
    'text-unreadable':
      'This paper’s stored text will not open, so there is nothing to read from. Extract its text again from the Queue screen and this can be generated.',
    failed: 'The last attempt produced nothing usable. Running it again may well work.',
    ready:
      'Generate this summary again from the paper as it stands now. The current one is kept as superseded provenance.'
  }
  const generateTip = generating
    ? 'A model is writing this summary now.'
    : loading
      ? 'Still reading what this paper already has.'
      : (STATE_TIP[state] ?? 'Run a model over this paper and generate the summary.')

  return (
    <Modal title={meta.title} onClose={onClose} testid={`summary-modal-${kind}`}>
      <div className="sum-modal">
        <div className="sum-head">
          <div className="sum-paper" title={plainText(title)}>
            <RichText text={title} />
          </div>
          <div className="sum-blurb">{meta.blurb}</div>
        </div>

        {/* WHAT WAS READ — but ONLY when it was not the whole paper.
            A summary written from an abstract, or from a supplementary file,
            states far less than one written from the full text, and the prose
            reads equally fluently either way, so that shortfall must be visible.
            "full text" must NOT: it is the expected case, and a badge that
            appears on every summary to say nothing is wrong is a badge people
            stop seeing — which costs the real warning its force. See the badge
            rule in CLAUDE.md. */}
        {state === 'ready' && (partialSource || cutShort) && (
          <div className="sum-scope" data-testid="summary-scope">
            {partialSource && (
              <span
                className="badge badge-warn"
                data-tip={`Written from ${summary?.source_scope} — not the whole paper, so this covers far less than the work does.`}
              >
                read: {summary?.source_scope}
              </span>
            )}
            {/* The model's own answer was cut short, which `source_scope`
                cannot express — that says what went IN. A summary missing its
                last paragraph is still true, so it is shown; presenting it as
                complete would not be. */}
            {cutShort && (
              <span
                className="badge badge-warn"
                data-tip="The model's answer was cut off before it finished. What is here is what it wrote; the closing points may be missing."
              >
                cut short
              </span>
            )}
          </div>
        )}

        <div className="sum-body">
          {loading && (
            <div className="sum-state sum-state-loading" data-testid="summary-loading">
              Loading…
            </div>
          )}

          {!loading && generating && (
            <div className="sum-state sum-state-busy" data-testid="summary-generating">
              <span className="sum-spinner" aria-hidden="true" />
              Writing the summary. This runs a model over the paper and takes a
              moment.
            </div>
          )}

          {/* An error sits BESIDE the prose, never instead of it. A failed
              rewrite is a failure of the attempt, not of the summary already
              held — replacing good text with an error message would destroy, on
              screen, the thing the user pressed a button to improve. */}
          {!busy && error && (
            <div className="sum-state sum-state-error" role="alert" data-testid="summary-error">
              {error}
            </div>
          )}

          {!busy && state === 'ready' && summary?.body && <Prose body={summary.body} />}

          {!busy && !error && state === 'missing' && (
            <div className="sum-state sum-state-empty" data-testid="summary-missing">
              No summary has been written for this paper yet.
            </div>
          )}

          {/* A run that produced nothing is NOT the same as no run: the button
              the user is about to press is the one that just failed, and
              saying so is the difference between an informed retry and a
              confused one. */}
          {!busy && !error && state === 'failed' && (
            <div className="sum-state sum-state-failed" data-testid="summary-failed">
              The last attempt did not produce a summary. Trying again may work —
              the model returned nothing usable.
            </div>
          )}

          {/* The REFUSALS. Each names the missing thing and the place it is
              fixed, because "could not summarise" sends the user looking in the
              wrong half of the app. */}
          {!busy && !error && state === 'no-source' && (
            <div className="sum-state sum-state-blocked" data-testid="summary-no-source">
              This paper has no text yet — only its title. Add its PDF from the
              Papers screen, or an abstract, and a summary can be written from
              what it actually says.
            </div>
          )}

          {/* NOT `no-source`, and the difference is the whole remedy. The text
              is HERE — extracted, stored, and unopenable — so telling the user
              to go and find a PDF sends them after a file the library already
              holds. Its own class as well as its own sentence: this is the
              app's own stored data being broken, which is a harder fact than a
              prerequisite that has simply not been met yet. */}
          {!busy && !error && state === 'text-unreadable' && (
            <div className="sum-state sum-state-damaged" data-testid="summary-text-unreadable">
              This paper’s text was extracted but cannot be read back — the
              stored copy is damaged. Extract its text again from the Queue
              screen, and this summary can be written from the whole paper.
            </div>
          )}

          {!busy && !error && state === 'no-dossier' && (
            <div className="sum-state sum-state-blocked" data-testid="summary-no-dossier">
              This project has no project context yet, so there is nothing to read
              the paper against. Add a few papers to the project context and build it —
              then this summary can say what the paper means here.
            </div>
          )}

          {!busy && !error && state === 'dossier-self-only' && (
            <div className="sum-state sum-state-blocked" data-testid="summary-dossier-self-only">
              Every claim in this project’s context comes from this paper, so
              there is nothing else to read it against — a paper cannot be its
              own background. Mark another paper as a reference and this summary
              can be written.
            </div>
          )}
        </div>

        {showProvenance && summary?.run && (
          <div className="sum-prov" data-testid="summary-provenance">
            <span className="mono">{summary.run.model}</span>
            <span className="sum-prov-sep">·</span>
            <span className="mono">{summary.run.prompt_version}</span>
            <span className="sum-prov-sep">·</span>
            <span>{fmtTime(summary.run.run_timestamp)}</span>
          </div>
        )}

        {/* `aria-disabled` rather than `disabled`, per the app's convention: a
            real disabled attribute suppresses hover, so the tooltip explaining
            WHY the button cannot be pressed would never reach the user. */}
        <div className="sum-foot">
          <button
            type="button"
            className={`btn btn-primary${generating ? ' is-busy' : ''}`}
            data-testid={`summary-generate-${kind}`}
            aria-disabled={busy || blocked}
            data-tip={generateTip}
            onClick={() => {
              if (busy || blocked) return
              generate()
            }}
          >
            <span className="btn-glyph" aria-hidden="true">
              ✎
            </span>
            {/* "Re-" only once a summary is actually held: pressing this then
                replaces prose the user already has, and they are owed that
                before the press rather than after it. */}
            {generating
              ? 'Generating…'
              : state === 'ready'
                ? 'Regenerate summary'
                : state === 'failed'
                  ? 'Try again'
                  : 'Generate summary'}
          </button>
          {/* Closing mid-generation is allowed: the run is persisted in the main
              process and completes regardless, so trapping the user in a modal
              to wait for it would be a lie about who owns the work. */}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * The pair of buttons. Rendered wherever a paper is actionable.
 *
 * `size` matches `DossierToggle` so the three sit on one row without the
 * summary buttons shouting over the toggle they follow.
 */
/**
 * "Read abstract" for a paper this library HOLDS — beside its two summaries,
 * because it is the third thing a reader may want to read about the paper and
 * the only one that is the paper's own words rather than a model's.
 *
 * It sits in the same row rather than in a panel of its own so the three read
 * as one choice: the paper's abstract, the general summary, the project
 * summary. A summary is generated and can be missing; an abstract either came
 * with the record or did not, so this button has no generate path — it is
 * absent when there is nothing to show, rather than offering an action that
 * cannot be taken.
 */
export function AbstractButton({
  abstract,
  title,
  size = 'md'
}: {
  abstract: string | null
  title: string
  size?: 'sm' | 'md'
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const text = abstract?.trim() ?? ''
  // NOTHING TO SHOW, SO NOTHING IS SHOWN. A disabled button would announce the
  // absence of an abstract on every metadata-only record in the library, which
  // is the badge-on-the-normal-case failure (hard rule 0.6) — and unlike a
  // summary there is no action it could offer.
  if (text.length === 0) return null

  return (
    <>
      <button
        type="button"
        className={`btn sum-btn sum-btn-${size}${open ? ' is-open' : ''}`}
        data-testid="abstract-open"
        data-tip="The paper's own abstract, as the record it was imported from printed it. Not written by a model."
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Abstract: ${title}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
          strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 3.5h8.5L16 7v9.5H4z" />
          <path d="M12.5 3.5V7H16" />
          <path d="M6.5 10h7M6.5 12.6h7M6.5 15.2h4" />
        </svg>
        Abstract
      </button>
      {open && (
        <Modal title={`Abstract — ${title}`} onClose={() => setOpen(false)} testid="abstract-modal">
          {/* Split on ANY newline, not only a blank line. `Prose` splits on the
              blank line the summary prompt is asked to emit; an abstract comes
              from an index and separates its Background/Methods/Results with a
              single one, which that rule would run together into a slab. */}
          <div className="sum-prose" data-testid="abstract-prose">
            {text
              .split(/\n\s*\n|\n/)
              .map((para) => para.trim())
              .filter(Boolean)
              .map((para, i) => (
                <p key={i}>
                  <RichText text={para} />
                </p>
              ))}
          </div>
        </Modal>
      )}
    </>
  )
}

export function SummaryButtons({
  workId,
  projectId,
  title,
  size = 'md',
  written
}: {
  workId: number
  projectId: number
  title: string
  size?: 'sm' | 'md'
  /**
   * Which of the two summaries this paper already HAS.
   *
   * Purely presentational: a button for a summary that has not been written is
   * dimmed, never disabled — pressing it is how one gets written, so disabling
   * would remove the very action the empty state calls for. It lets a reader
   * scan a list and see which papers have been summarised without opening
   * anything.
   *
   * Omitted where the caller does not know (the Paper screen shows one paper
   * and reads the real thing on open), in which case neither is dimmed —
   * guessing "not written" would grey a button for a summary that exists.
   */
  written?: { general: boolean; project: boolean }
}): JSX.Element {
  const [open, setOpen] = useState<SummaryKind | null>(null)

  return (
    <>
      {(['general', 'project'] as const).map((kind) => {
        const dim = written ? !written[kind] : false
        return (
        <button
          key={kind}
          type="button"
          className={`btn sum-btn sum-btn-${size}${open === kind ? ' is-open' : ''}${
            dim ? ' is-empty' : ''
          }`}
          data-testid={`summary-open-${kind}-${workId}`}
          data-tip={
            dim
              ? `Not written yet. ${KIND_META[kind].tip} Opening lets you generate it.`
              : KIND_META[kind].tip
          }
          aria-haspopup="dialog"
          aria-expanded={open === kind}
          aria-label={`${KIND_META[kind].label}: ${plainText(title)}`}
          onClick={(e) => {
            // Rows are themselves clickable; opening a summary must not also
            // navigate to the paper.
            e.stopPropagation()
            setOpen(kind)
          }}
        >
          {/* A DOCUMENT, in both states. A bare rectangle is indistinguishable
              from a missing glyph — the un-written button read as tofu. The
              folded corner makes the outline a page at 13px whether or not it
              has been written, and the written/un-written difference is carried
              by the ruled lines: solid and full-width when a summary exists,
              faint and short when it is still to be written. Shape AND opacity,
              never tint alone. */}
          <svg
            width="13"
            height="13"
            viewBox="0 0 20 20"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 2.75h6.5L15.25 6.5v10.75H5z" />
            <path d="M11.25 2.75v3.9h4" />
            {dim ? (
              <g opacity="0.45" strokeDasharray="2 2.2">
                <path d="M7.5 10.5h5M7.5 13.5h3" />
              </g>
            ) : (
              <path d="M7.5 10.5h5M7.5 13.5h5" />
            )}
          </svg>
          {size === 'sm' ? KIND_META[kind].short : KIND_META[kind].label}
        </button>
        )
      })}

      {open && (
        <SummaryModal
          workId={workId}
          projectId={projectId}
          kind={open}
          title={plainText(title)}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
