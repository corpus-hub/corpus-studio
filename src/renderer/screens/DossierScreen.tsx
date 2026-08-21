import { useEffect, useMemo, useRef, useState } from 'react'
import type { DossierBriefingDTO, DossierPaperDTO, DossierStatusDTO } from '@shared/contract'
import { useAsync } from '../lib/useAsync'
import { DataView, EmptyState } from '../components/States'
import { Badge, DossierToggle, Select } from '../components/ui'
import { DOSSIER_PAPER_LIMIT } from '@shared/contract'
import { fmtYear, relevanceForDisplay } from '../lib/format'
import { RichText, plainText } from '../components/RichText'
import { useShowProvenance } from '../lib/prefs'

/**
 * Topic Dossier — the BRIEFING a model is given before it reads any one paper.
 *
 * The point of the feature is to let an AI understand the scope of a collection
 * without being handed the collection: a few thousand words of background in
 * place of a few hundred thousand of source. So the screen is the briefing
 * itself, in the order a model receives it, and every section states what it
 * costs.
 *
 * WHAT IS DELIBERATELY NOT HERE: extracted values. A measurement is what the
 * corpus KNOWS; background is what a reader needs in order to understand what
 * the corpus is talking about. A model is quoted a measurement when it reads the
 * paper that reported it — sending them as background states a number with no
 * paper attached, and fills a context window with the one thing that did not
 * need to be there.
 *
 * The five sections, in the order they are read:
 *   1. what this project is for      — the user's own project description
 *   2. what the words mean here      — the definitions on the attached schemas
 *   3. which papers matter, and why  — every paper, grouped by its role
 *   4. what each paper adds          — the opening of each project summary
 *   5. what the chosen papers establish — the only part an AI must write
 *
 * All content is read from SQLite via `window.api` (`getDossierBriefing` +
 * `getDossierStatus`). No domain literals here; every string below is either a
 * DB value or a label about the app's own mechanics.
 */

type Payload = { briefing: DossierBriefingDTO; status: DossierStatusDTO }

/** A stored ISO timestamp as `8 Feb 2020, 18:00:33`. */
const fmtWhen = (iso: string | null): string => {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

/**
 * Characters → the size a reader can judge, in WORDS.
 *
 * ~5.5 characters per English word including its trailing space. Deliberately
 * NOT the 4-chars-per-token figure model vendors publish: a token is a unit of
 * someone else's tokenizer, this app ships none, and printing tokens as "words"
 * overstates every number on the screen by about a third. A word is a unit the
 * person choosing papers can actually picture.
 *
 * Approximate on purpose, and always rendered with a leading `~`.
 */
const words = (chars: number): string => `~${Math.round(chars / 5.5).toLocaleString()} words`

const SORTS = [
  { key: 'relevance', label: 'relevance', tip: "How closely the paper bears on this project's question." },
  { key: 'size', label: 'how much to read', tip: 'How much stored text a build would have to read.' },
  { key: 'year', label: 'year', tip: 'Publication year, newest first.' },
  { key: 'title', label: 'title', tip: 'Alphabetical by title.' }
] as const
type SortKey = (typeof SORTS)[number]['key']

// ---------------------------------------------------------------- components

/**
 * One section of the briefing.
 *
 * The explanation is a TOOLTIP, not a paragraph: five explanatory paragraphs
 * stacked down a page is five paragraphs nobody reads, and the heading carries
 * the meaning on its own. The size is always shown — it is the constraint the
 * whole feature exists to manage, so it is not an exception to Hard Rule 0.6.
 */
function Section({
  n,
  id,
  title,
  why,
  size,
  children
}: {
  n: number
  id: string
  title: string
  why: string
  size: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="ds-sec" data-testid={`dossier-section-${id}`} aria-labelledby={`ds-h-${id}`}>
      <div className="ds-sec-h">
        <span className="ds-sec-n" aria-hidden="true">
          {n}
        </span>
        <h2 className="ds-sec-t" id={`ds-h-${id}`} data-tip={why}>
          {title}
        </h2>
        <span
          className="badge badge-muted ds-sec-size"
          data-tip="Roughly how much of a model's reading space this takes"
        >
          {size}
        </span>
      </div>
      <div className="ds-sec-b">{children}</div>
    </section>
  )
}

/**
 * The project's own statement, with the structure the user gave it.
 *
 * `description` is COMPOSED (see `composeProjectDescription` in main): the goal,
 * a blank line, the heading "Questions this project asks:", then one `- ` line
 * per question. Rendered as a single string, HTML collapsed every newline and
 * it came back as an unreadable run-on — the question list ran into the goal
 * and the leading hyphens read as dashes mid-sentence.
 *
 * PARSED BACK, not merely `white-space: pre-line`. The whitespace fix alone
 * makes it legible; splitting it makes it READ like what it is — a statement
 * followed by a list of questions, which is how the setup form asked for it and
 * how a reader thinks about it. The CSS keeps `pre-line` anyway, so a goal with
 * its own paragraph breaks still shows them.
 *
 * TOLERANT of anything that does not match: a description typed by hand, one
 * from a project made before the questionnaire, or an imported archive's, has
 * no heading and simply renders as prose. Nothing is dropped in any case — the
 * parse only decides how the same text is laid out.
 */
/**
 * The composed description, taken back apart into the halves it was made from.
 *
 * ONE parse, used by the reader and by the editor, so what is shown and what is
 * offered for editing can never disagree about where the goal ends. TOLERANT:
 * text with no heading is all goal and no questions, which is exactly right for
 * a description typed by hand, imported from an archive, or written before the
 * questionnaire existed.
 */
function splitStatement(text: string): { goal: string; questions: string[] } {
  const marker = '\nQuestions this project asks:'
  const at = text.indexOf(marker)
  if (at === -1) return { goal: text.trim(), questions: [] }
  return {
    goal: text.slice(0, at).trim(),
    questions: text
      .slice(at + marker.length)
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter((l) => l !== '')
  }
}

function ProjectStatement({ text }: { text: string }): JSX.Element {
  if (text.indexOf('\nQuestions this project asks:') === -1)
    return <p className="ds-about">{text}</p>
  const { goal, questions } = splitStatement(text)

  return (
    <div className="ds-about" data-testid="dossier-about">
      {goal}
      {questions.length > 0 && (
        <>
          <p className="ds-about-h">Questions this project asks</p>
          <ul className="ds-about-list">
            {questions.map((q, i) => (
              <li key={i} className="ds-about-q">
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * SECTION 1, WRITEABLE — the goal and the questions, edited where they are read.
 *
 * WHAT IS EDITED IS NOT WHAT IS SHOWN. The section quotes `project.description`,
 * and that string is COMPOSED in main from the two halves below on every write
 * (`composeProjectDescription`). Editing the composed text directly would be
 * overwritten by the next save of either half, so this form owns the halves and
 * lets main recompose — the same contract `updateProjectSetup` already carries
 * for the setup page, which is why no new IPC method exists for this.
 *
 * SAME INTERACTION AS THE SETUP PAGE, deliberately: written on blur, one field
 * left is one field written, and a trailing blank question box that regrows as
 * soon as it is typed into. Two forms over the same two fields that committed at
 * different moments would be two answers to "is my typing saved yet".
 *
 * The re-ranking consequence is stated ABOVE the fields, before anything is
 * typed. A user correcting a typo in their goal is not told afterwards, by
 * finding a ranking they spent an afternoon on reshuffled.
 */
function AboutEditor({
  projectId,
  about,
  onClose,
  onSaved
}: {
  projectId: number
  /**
   * The composed text as section 1 shows it, as the FALLBACK seed.
   *
   * `goal` and `questions` are only populated for projects that went through the
   * questionnaire. An older project, an imported archive or a hand-written
   * description has the composed `description` and nothing else, so seeding from
   * the columns alone would open an EMPTY form over visible text — and the first
   * blur would recompose that emptiness over the words the user could still see.
   */
  about: string | null
  onClose: () => void
  /** The briefing is recomposed in main, so section 1 must be re-read. */
  onSaved: () => void
}): JSX.Element {
  const [goal, setGoal] = useState<string | null>(null)
  const [questions, setQuestions] = useState<string[]>([''])
  const [saving, setSaving] = useState(false)
  /** A refused write, kept until the next one succeeds — the text is NOT reset. */
  const [failed, setFailed] = useState<string | null>(null)
  const goalRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    void window.api
      .getProject(projectId)
      .then((p) => {
        if (!alive || !p) return
        const parsed = splitStatement(about ?? '')
        const g = (p.goal ?? '').trim() !== '' ? (p.goal ?? '') : parsed.goal
        const qs = p.questions.length > 0 ? p.questions : parsed.questions
        setGoal(g)
        // Always a trailing blank row: it is the control that invites the next
        // question, so a project with three saved questions offers a fourth box.
        setQuestions(qs.length > 0 ? [...qs, ''] : [''])
      })
      .catch((e: unknown) => {
        if (alive) setFailed(`Could not read this project: ${e instanceof Error ? e.message : String(e)}`)
      })
    return () => {
      alive = false
    }
  }, [projectId])

  // Focus lands on the goal once it has arrived, so opening the editor with the
  // keyboard puts the caret where the reader is looking rather than nowhere.
  useEffect(() => {
    if (goal !== null) goalRef.current?.focus()
  }, [goal !== null])

  const save = (patch: { goal?: string; questions?: string[] }): void => {
    setSaving(true)
    void window.api
      .updateProjectSetup({ projectId, ...patch })
      .then(() => {
        setFailed(null)
        onSaved()
      })
      .catch((e: unknown) =>
        // The user's text stays in the boxes: a refused write is a reason to try
        // again, and throwing away what they typed makes trying again retyping.
        setFailed(
          `That was not saved, and your text is still here. ${e instanceof Error ? e.message : String(e)}`
        )
      )
      .finally(() => setSaving(false))
  }

  const setQuestionAt = (i: number, v: string): void => {
    setQuestions((cur) => {
      const next = [...cur]
      next[i] = v
      if (i === next.length - 1 && v.trim() !== '') next.push('')
      return next
    })
  }

  const removeQuestionAt = (i: number): void => {
    setQuestions((cur) => {
      const next = cur.filter((_, j) => j !== i)
      const withTail = next.length === 0 || next[next.length - 1].trim() !== '' ? [...next, ''] : next
      save({ questions: withTail })
      return withTail
    })
  }

  if (goal === null) {
    return (
      <div className="ds-about-edit" data-testid="dossier-about-editor">
        <p className="ds-about-editing">Opening what you wrote…</p>
        {failed && (
          <p className="ds-about-failed" role="alert" data-testid="dossier-about-failed">
            {failed}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="ds-about-edit" data-testid="dossier-about-editor">
      {/* THE CONSEQUENCE, BEFORE THE FIELDS. A sentence rather than a warning
          badge: nothing here is going wrong, and a red chip over an ordinary
          edit teaches the reader to dismiss chips. */}
      <p className="ds-about-consequence">
        These two answers are what every paper is ranked against. Changing either
        one re-ranks every paper in this project, so the order you see on the
        Ranking screen will be worked out again from your new words.
      </p>

      <label className="ds-about-lbl" htmlFor="ds-about-goal">
        What is this project about?
      </label>
      <textarea
        id="ds-about-goal"
        ref={goalRef}
        className="input textarea ds-about-input"
        data-testid="dossier-about-goal"
        rows={4}
        value={goal}
        placeholder="The subject you are working on, and what you want to learn about it."
        disabled={saving}
        onChange={(e) => setGoal(e.target.value)}
        onBlur={() => save({ goal: goal.trim() })}
      />

      <p className="ds-about-lbl">What questions do you want answered?</p>
      <div className="ds-about-qs" data-testid="dossier-about-questions">
        {questions.map((q, i) => {
          const last = i === questions.length - 1
          return (
            <div className="ds-about-qrow" key={i}>
              <span className="ds-about-qmark" aria-hidden="true">
                ?
              </span>
              <input
                className="input ds-about-input"
                data-testid={`dossier-about-question-${i}`}
                aria-label={`Question ${i + 1}`}
                value={q}
                placeholder={
                  i === 0 ? 'Something you want to know from every paper.' : 'Add another question…'
                }
                disabled={saving}
                onChange={(e) => setQuestionAt(i, e.target.value)}
                onBlur={() => save({ questions })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  save({ questions })
                  document
                    .querySelectorAll<HTMLInputElement>('[data-testid^="dossier-about-question-"]')
                    [i + 1]?.focus()
                }}
              />
              {/* Never on the trailing blank: there is nothing to remove there,
                  and a live control beside an empty box invites a press that
                  deletes the row about to be typed in. */}
              <button
                type="button"
                className="ds-about-qx"
                data-testid={`dossier-about-question-remove-${i}`}
                aria-label={`Remove question ${i + 1}`}
                data-tip="Remove this question"
                style={last && q.trim() === '' ? { visibility: 'hidden' } : undefined}
                disabled={saving || (last && q.trim() === '')}
                onClick={() => removeQuestionAt(i)}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      {failed && (
        <p className="ds-about-failed" role="alert" data-testid="dossier-about-failed">
          {failed}
        </p>
      )}

      <div className="ds-about-actions">
        <span className={`ds-about-state${saving ? ' is-saving' : ''}`} role="status">
          {saving ? 'Saving…' : 'Saved as you type.'}
        </span>
        <button
          type="button"
          className="btn btn-secondary btn-sm ds-about-done"
          data-testid="dossier-about-done"
          disabled={saving}
          data-tip={saving ? 'Waiting for the last change to be written.' : undefined}
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  )
}

/**
 * One rail row — the same component as the Connectome's `.cg-paper-row`, plus
 * the membership toggle this screen exists for.
 *
 * The metric on the right tracks whatever the rail is SORTED BY, so the ordering
 * is always legible rather than being by an invisible value.
 */
function PaperRow({
  paper,
  sort,
  busy,
  failed,
  atLimit,
  onToggle,
  onOpen
}: {
  paper: DossierPaperDTO
  sort: SortKey
  busy: boolean
  /** This row's write was refused — reported HERE, not in a page-wide bar. */
  failed: string | null
  /** The context is full, so a paper not already in it cannot be added. */
  atLimit: boolean
  onToggle: (workId: number, next: boolean) => void
  onOpen: (workId: number) => void
}): JSX.Element {
  const metric =
    sort === 'year'
      ? String(paper.year ?? '—')
      : sort === 'size'
        ? paper.paragraphs > 0
          ? `${paper.paragraphs}p`
          : '—'
        : // The RANK, not the score. Relevances are ordinal sigmoids with a
          // median near 0.0004 on a real corpus, so `raw * 10` printed "0.0"
          // down the whole rail. The rail's ORDER still comes from the raw
          // value, which is what the repository sorts on.
          paper.relevance === null
          ? '—'
          : ((relevanceForDisplay(paper) as number) * 10).toFixed(1)
  // The number is whatever the rail is sorted by, so the explanation has to
  // move with it — a fixed tip would name the wrong quantity three sorts out of
  // four. An em dash means the value is not known for this paper, which is a
  // different statement from a low one and says so.
  const metricTip =
    sort === 'year'
      ? paper.year === null
        ? 'No publication year is recorded for this paper.'
        : `Published ${paper.year}.`
      : sort === 'size'
        ? paper.paragraphs > 0
          ? `${paper.paragraphs} paragraph(s) of stored text — how much a build would have to read.`
          : 'No text is stored for this paper, so a build has nothing to read from it.'
        : paper.relevance === null
          ? 'Nothing has scored this paper against the project’s question yet.'
          : `${((relevanceForDisplay(paper) as number) * 10).toFixed(1)} out of 10 — where this paper ` +
            'sits among the papers scored beside it for how closely it bears on the project’s ' +
            'question. An order, not a measurement: it moves when another paper is scored.'
  // In the dossier but with nothing stored to read: the one row the user must
  // act on, so it leaves the accent tint rather than sharing it (Hard Rule 0.6 —
  // this is a shortfall they have to resolve, not a status).
  const unreadable = paper.is_reference && paper.paragraphs === 0
  return (
    <div
      className={`ds-row${paper.is_reference ? ' is-on' : ''}${unreadable ? ' is-empty' : ''}${busy ? ' is-busy' : ''}`}
      data-testid={`dossier-paper-${paper.work_id}`}
    >
      <span className="ds-row-dot" style={{ background: 'var(--border)' }} aria-hidden="true" />
      <button
        type="button"
        className="ds-row-main"
        data-tip={paper.title}
        onClick={() => onOpen(paper.work_id)}
        aria-label={`Open paper: ${paper.title}`}
      >
        <span className="ds-row-title">{paper.title}</span>
        {unreadable && (
          <span className="ds-row-warn">no text stored — a build has nothing to read</span>
        )}
        {/* The same treatment Ranking gives a refused write: on the row it
            happened to, with a glyph so it is not carried by colour alone. */}
        {failed && (
          <span className="rank-save-failed" data-testid={`dossier-save-failed-${paper.work_id}`} role="alert">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 2.6L18 16.6H2z" />
              <path d="M10 8v3.6" />
              <path d="M10 14.1v.1" />
            </svg>
            {failed}
          </span>
        )}
      </button>
      <span className="ds-row-metric mono" data-tip={metricTip}>
        {metric}
      </span>
      {/* THE SHARED CONTROL, not a local one. `DossierToggle` exists so this
          decision reads and behaves identically wherever it is offered — the
          Ranking rows, the Paper header and here — and this screen is the
          destination it is named after. A switch of its own would have put the
          same fact in two colours one tab apart. */}
      <DossierToggle
        on={paper.is_reference}
        title={paper.title}
        testid={`dossier-toggle-${paper.work_id}`}
        size="sm"
        atLimit={atLimit}
        onToggle={(next) => onToggle(paper.work_id, next)}
      />
    </div>
  )
}

// ------------------------------------------------------------------- screen

export function DossierScreen({
  projectId,
  onOpenWork,
  onAddPapers
}: {
  projectId: number
  onOpenWork: (id: number) => void
  /** Leave for the Papers screen, for a project with nothing to build from. */
  onAddPapers: () => void
}): JSX.Element {
  const [building, setBuilding] = useState(false)
  /**
   * The two failures are kept apart because they are different sentences about
   * different actions. A COMPILE was refused — that is about the whole dossier,
   * so it is reported at the top. A paper's membership was not saved — that is
   * about ONE row, so it is reported on that row, as Ranking does. Sharing one
   * slot meant a toggle silently wiped the reason a build had just declined.
   */
  const [buildError, setBuildError] = useState<string | null>(null)
  const [saveFailed, setSaveFailed] = useState<{ workId: number; sentence: string } | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('relevance')
  const [scope, setScope] = useState<'all' | 'in'>('all')
  /** The work whose membership is being written, so its row can say so. */
  const [pending, setPending] = useState<number | null>(null)

  const load = async (): Promise<Payload> => ({
    briefing: await window.api.getDossierBriefing(projectId),
    status: await window.api.getDossierStatus(projectId)
  })
  const state = useAsync<Payload>(load, [projectId])

  const build = async (): Promise<void> => {
    setBuilding(true)
    setBuildError(null)
    try {
      await window.api.buildDossier(projectId)
      state.reload()
    } catch (e) {
      // The reason a build refused is the useful part — swallowing it would
      // leave a button that silently does nothing.
      setBuildError(e instanceof Error ? e.message : String(e))
    } finally {
      setBuilding(false)
    }
  }

  const toggle = async (workId: number, next: boolean): Promise<void> => {
    setPending(workId)
    setSaveFailed(null)
    try {
      await window.api.markReference(projectId, workId, next)
      // AWAIT the re-read before clearing the busy mark. `reload()` only bumps a
      // nonce, so clearing on its return un-dimmed the row while it still showed
      // the pre-toggle value — the switch appeared to do nothing, then moved.
      await load()
      state.reload()
    } catch (e) {
      // Re-read rather than trusting the optimistic value: a refused write must
      // put the switch back to what is STORED, not to what was clicked.
      setSaveFailed({
        workId,
        sentence: `That project-context change was not saved — the switch has been put back to what is stored. ${
          e instanceof Error ? e.message : String(e)
        }`
      })
      state.reload()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="screen screen-dossier" data-testid="screen-dossier">
      <h1 className="visually-hidden">Project context</h1>
      <DataView state={state} isEmpty={() => false}>
        {({ briefing, status }) => (
          <DossierBody
            projectId={projectId}
            briefing={briefing}
            status={status}
            building={building}
            buildError={buildError}
            saveFailed={saveFailed}
            query={query}
            sort={sort}
            scope={scope}
            pending={pending}
            onQuery={setQuery}
            onSort={setSort}
            onScope={setScope}
            onBuild={() => void build()}
            onReload={state.reload}
            onToggle={(w, n) => void toggle(w, n)}
            onOpenWork={onOpenWork}
            onAddPapers={onAddPapers}
          />
        )}
      </DataView>
    </div>
  )
}

function DossierBody({
  projectId,
  briefing,
  status,
  building,
  buildError,
  saveFailed,
  query,
  sort,
  scope,
  pending,
  onQuery,
  onSort,
  onScope,
  onBuild,
  onReload,
  onToggle,
  onOpenWork,
  onAddPapers
}: {
  projectId: number
  briefing: DossierBriefingDTO
  status: DossierStatusDTO
  building: boolean
  buildError: string | null
  saveFailed: { workId: number; sentence: string } | null
  query: string
  sort: SortKey
  scope: 'all' | 'in'
  pending: number | null
  onQuery: (v: string) => void
  onSort: (v: SortKey) => void
  onScope: (v: 'all' | 'in') => void
  onBuild: () => void
  /** Re-read the briefing after an edit that main recomposed. */
  onReload: () => void
  onToggle: (workId: number, next: boolean) => void
  onOpenWork: (id: number) => void
  onAddPapers: () => void
}): JSX.Element {
  const { papers, terms, contributions, about, sizes } = briefing
  const chosen = papers.filter((p) => p.is_reference)
  // Counted from the list this screen already holds — it shows every paper in
  // the project, so no round trip is needed to know whether another may go in.
  const atLimit = chosen.length >= DOSSIER_PAPER_LIMIT
  const total = sizes.about + sizes.terms + sizes.papers + sizes.contributions + sizes.compiled
  const showProvenance = useShowProvenance()
  const [editingAbout, setEditingAbout] = useState(false)

  // What a build would actually read, so the panel can price it before running.
  const toRead = chosen.reduce(
    (a, p) => ({ paras: a.paras + p.paragraphs, chars: a.chars + p.chars }),
    { paras: 0, chars: 0 }
  )

  const rail = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cmp: Record<SortKey, (a: DossierPaperDTO, b: DossierPaperDTO) => number> = {
      relevance: (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0),
      size: (a, b) => b.paragraphs - a.paragraphs,
      year: (a, b) => (b.year ?? 0) - (a.year ?? 0),
      title: (a, b) => a.title.localeCompare(b.title)
    }
    // Title is the tie-break for every numeric sort, so the order is stable
    // rather than dependent on the DB's row order — the Connectome's rule.
    return papers
      .filter((p) => (scope === 'all' || p.is_reference) && (!q || p.title.toLowerCase().includes(q)))
      .sort((a, b) => cmp[sort](a, b) || a.title.localeCompare(b.title))
  }, [papers, query, sort, scope])

  const titleOf = useMemo(() => new Map(papers.map((p) => [p.work_id, p.title])), [papers])

  return (
    <>
      {/* ------------------------------------------- state, and the control */}
      <header className="ds-hdr">
        <span
          className="badge badge-accent ds-size"
          data-tip="Roughly how much of a model's reading space the whole briefing takes."
        >
          {words(total)}
        </span>
        <span className="ds-when mono" data-testid="dossier-built-at">
          {status.built_at
            ? showProvenance
              ? `generated ${fmtWhen(status.built_at)} · ${status.built_model ?? 'unknown model'} · prompt ${status.built_prompt_version ?? '?'}`
              : fmtWhen(status.built_at)
            : 'not generated yet'}
        </span>
        {/* THREE STATES, and the middle one is the point.
              · enabled  — accent fill: a rebuild would read something different.
              · CURRENT  — quiet fill with a dotted underline: the app believes a
                rebuild reproduces what is stored. STILL CLICKABLE, because that
                belief is about inputs the app can hash, and a user rebuilding
                anyway may have a reason none of them covers.
              · disabled — no papers chosen: there is nothing to read, so the
                press cannot be honoured at all.
            The quiet state must never look like the refused one, or "I could do
            this" and "I cannot do this" become the same grey. */}
        <button
          type="button"
          className={`btn ${chosen.length > 0 && status.current && !building ? 'btn-secondary ds-build-current' : 'btn-primary'}`}
          data-testid="dossier-build-btn"
          data-current={chosen.length > 0 && status.current ? 'true' : undefined}
          // DISABLED WHEN CURRENT, not merely quiet. A rebuild over unchanged
          // inputs reads every chosen paper through the model again to write
          // back what is already stored — minutes of work and a bill, for no
          // difference. The tip says what would have to change for the button to
          // come back, so the state is an answer rather than a dead control.
          disabled={chosen.length === 0 || building || status.current}
          data-tip={
            chosen.length === 0
              ? papers.length > 0
                ? 'Put at least one paper in the project context first — a build over papers you never chose would record work you did not ask for.'
                : 'This project has no papers yet.'
              : status.current
                ? 'Already current: the same papers, the same text, the same prompt and model. Add or remove a paper in the project context, or change the model, and this comes back.'
                : status.built_at
                  ? `Read the ${chosen.length} chosen paper${chosen.length === 1 ? '' : 's'} together again and replace the project context with what they establish now.`
                  : `Read the ${chosen.length} chosen paper${chosen.length === 1 ? '' : 's'} together and record what they establish.`
          }
          onClick={onBuild}
        >
          {building
            ? 'Generating…'
            : status.built_at
              ? 'Regenerate project context'
              : 'Generate project context'}
        </button>
      </header>

      {buildError && (
        <p className="ds-err" role="alert" data-testid="dossier-build-error">
          {buildError}
        </p>
      )}

      <div className="ds-body">
        {/* ------------------------------------------------- rail: the papers */}
        <aside className="ds-rail" data-testid="dossier-rail">
          <div className="cg-papers-head">
            <span className="eyebrow">Papers</span>
            <span className="cg-papers-n mono">{rail.length}</span>
          </div>
          <div className="cg-papers-filter">
            <input
              className="input input-sm cg-papers-input"
              data-testid="dossier-rail-search"
              placeholder="Find a paper"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
            />
            <Select<SortKey>
              testid="dossier-rail-sort"
              ariaLabel="Sort papers by"
              className="input-sm"
              value={sort}
              format={(l) => `Sort: ${l}`}
              options={SORTS.map((o) => ({ value: o.key, label: o.label, tip: o.tip }))}
              onChange={onSort}
            />
            <div className="sem-mode-group ds-scope" role="group" aria-label="Which papers to show">
              <button
                type="button"
                className={`sem-mode${scope === 'all' ? ' is-on' : ''}`}
                aria-pressed={scope === 'all'}
                data-testid="dossier-scope-all"
                onClick={() => onScope('all')}
              >
                All <span className="mono">{papers.length}</span>
              </button>
              <button
                type="button"
                className={`sem-mode${scope === 'in' ? ' is-on' : ''}`}
                aria-pressed={scope === 'in'}
                data-testid="dossier-scope-in"
                onClick={() => onScope('in')}
              >
                In project context <span className="mono">{chosen.length}</span>
              </button>
            </div>
          </div>
          <div className="cg-papers-rows">
            {rail.length === 0 ? (
              <div className="cg-papers-none">
                {papers.length === 0 ? 'This project has no papers yet.' : 'No paper matches that.'}
              </div>
            ) : (
              rail.map((p) => (
                <PaperRow
                  key={p.work_id}
                  paper={p}
                  sort={sort}
                  busy={pending === p.work_id}
                  failed={saveFailed?.workId === p.work_id ? saveFailed.sentence : null}
                  atLimit={atLimit}
                  onToggle={onToggle}
                  onOpen={onOpenWork}
                />
              ))
            )}
          </div>
        </aside>

        {/* ------------------------------------------------ the briefing */}
        <main className="ds-main">
          {papers.length === 0 ? (
            <EmptyState
              title="Nothing to brief an AI about yet."
              hint="A project context is built from the papers you trust, so it starts with the papers."
            >
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="dossier-empty-add-papers"
                  onClick={onAddPapers}
                >
                  Add papers
                </button>
              </div>
            </EmptyState>
          ) : (
            <>
              <div className="ds-brief-h">
                <h2>The briefing, in the order the AI reads it</h2>
              </div>

              <Section
                n={1}
                id="about"
                title="What this project is for"
                why="Your own words. The first thing a model is told, so everything after it is read in that light."
                size={words(sizes.about)}
              >
                {editingAbout ? (
                  <AboutEditor
                    projectId={projectId}
                    about={about}
                    onClose={() => setEditingAbout(false)}
                    onSaved={onReload}
                  />
                ) : (
                  <>
                    {about ? (
                      <ProjectStatement text={about} />
                    ) : (
                      <p className="ds-about is-empty" data-testid="dossier-no-about">
                        Nothing written yet. Without it a model has to infer what you are doing from
                        the papers.
                      </p>
                    )}
                    <div className="ds-about-bar">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm ds-about-edit-btn"
                        data-testid="dossier-about-edit"
                        data-tip="Change the goal and the questions this project asks. Both are re-read by every ranking."
                        onClick={() => setEditingAbout(true)}
                      >
                        {about ? 'Edit' : 'Write it'}
                      </button>
                    </div>
                  </>
                )}
              </Section>

              <Section
                n={2}
                id="terms"
                title="What the words mean here"
                why="The definitions you wrote on your extraction schemas. This is what stops a model guessing at your vocabulary."
                size={words(sizes.terms)}
              >
                {terms.length === 0 ? (
                  <p className="ds-none" data-testid="dossier-no-terms">
                    No schema is attached to this project, so nothing here defines its terms.
                  </p>
                ) : (
                  terms.map((g) => (
                    <div className="ds-defgrp" key={g.schema_id}>
                      <div className="ds-defgrp-h">
                        <span className="ds-defgrp-n" data-tip={g.description ?? 'no description'}>
                          {g.name}
                        </span>
                        <span className="ds-defgrp-c mono">
                          {g.terms.length} term{g.terms.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <dl className="ds-defs">
                        {g.terms.map((t) => (
                          <div className="ds-def" key={`${g.schema_id}-${t.label}`}>
                            <dt>
                              {t.label}
                              {t.unit && <span className="ds-def-u mono">{t.unit}</span>}
                            </dt>
                            <dd>
                              {t.description ?? (
                                <span className="ds-def-none">no definition written</span>
                              )}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))
                )}
              </Section>

              <Section
                n={3}
                id="papers"
                title="Which papers matter, and why each is here"
                why="Every paper in the project, so a model reads the collection it is being asked about."
                size={words(sizes.papers)}
              >
                <ul className="ds-rolelist">
                  {papers.map((p) => (
                    <li className={`ds-rl${p.is_reference ? ' is-in' : ''}`} key={p.work_id}>
                      <button
                        type="button"
                        className="ds-rl-t"
                        onClick={() => onOpenWork(p.work_id)}
                        aria-label={`Open paper: ${plainText(p.title)}`}
                      >
                        <RichText text={p.title} />
                      </button>
                      <span className="ds-rl-y mono">{fmtYear(p.year)}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section
                n={4}
                id="adds"
                title="What each paper adds to the collection"
                why="The opening of each project summary — written against the rest of the collection, not about the paper alone."
                size={words(sizes.contributions)}
              >
                {contributions.length === 0 ? (
                  <p className="ds-none" data-testid="dossier-no-contributions">
                    No paper has a summary written for this project yet.
                  </p>
                ) : (
                  <ul className="ds-addlist">
                    {contributions.map((c) => (
                      <li key={c.work_id}>
                        <details className="ds-add">
                          <summary className="ds-add-h">
                            <span className="ds-add-t">{titleOf.get(c.work_id) ?? c.title}</span>
                            {/* Only the shortfall: a summary read from the full
                                text is what one is supposed to be. */}
                            {c.source_scope !== null && c.source_scope !== 'full text' && (
                              <Badge cls="warn">read: {c.source_scope}</Badge>
                            )}
                            <span className="ds-chev" aria-hidden="true" />
                          </summary>
                          <p className="ds-add-p">{c.opening}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {/* The one section the briefing cannot assemble for itself. */}
              <section
                className={`ds-sec ds-sec-compile${sizes.compiled > 0 ? ' is-done' : ''}`}
                data-testid="dossier-section-compiled"
                aria-labelledby="ds-h-compiled"
              >
                <div className="ds-sec-h">
                  <span className="ds-sec-n" aria-hidden="true">
                    5
                  </span>
                  <h2
                    className="ds-sec-t"
                    id="ds-h-compiled"
                    data-tip="Terms and their synonyms, how a quantity is defined, what a value is compared against, and any convention the papers rely on. The only part that reads the chosen papers together rather than one at a time."
                  >
                    What the chosen papers establish
                  </h2>
                  <span className={`badge ${sizes.compiled > 0 ? 'badge-muted' : 'badge-warn'} ds-sec-size`}>
                    {sizes.compiled > 0 ? words(sizes.compiled) : 'not generated yet'}
                  </span>
                </div>
                <div className="ds-sec-b">
                  <p className="ds-compile-p">
                    {sizes.compiled > 0
                      ? `Generated from your ${status.built_work_ids.length} chosen paper${status.built_work_ids.length === 1 ? '' : 's'}, read together. It reaches a model as background when any paper in this project is analysed.`
                      : chosen.length === 0
                        ? 'No paper is in the project context, so there is nothing to read together. Put one in from the rail.'
                        : `Reads your ${chosen.length} chosen paper${chosen.length === 1 ? '' : 's'} together and writes down what they agree on, where they use different words for the same thing, and where they disagree.`}
                  </p>
                  {chosen.length > 0 && sizes.compiled === 0 && (
                    <div className="ds-compile-in">
                      <span>
                        <b className="mono">{toRead.paras.toLocaleString()}</b> paragraphs
                      </span>
                      <span>
                        <b className="mono">{words(toRead.chars).replace('~', '')}</b> of source
                      </span>
                    </div>
                  )}
                </div>
              </section>

            </>
          )}
        </main>
      </div>
    </>
  )
}
