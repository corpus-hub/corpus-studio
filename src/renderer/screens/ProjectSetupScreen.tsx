import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectDTO, ProjectWorkDTO } from '@shared/types'
import type { ExtractionSchemaDTO, JobDTO } from '@shared/contract'
import { useAsync } from '../lib/useAsync'
import { isOutstandingFailure } from '../lib/jobs'
import { DataView } from '../components/States'
import { PdfDropZone } from '../components/PdfDropZone'
import { WebSearchPanel } from './IngestScreen'
import { SchemaCreateModal } from '../components/SchemaCreateModal'
import { ZoteroOfflineModal } from '../components/ZoteroOfflineModal'
import { RichText, plainText } from '../components/RichText'

/**
 * THE CREATION QUESTIONNAIRE.
 *
 * A project is created from a NAME alone; everything that makes it answerable is
 * asked here, on a page, because none of it fits in a dialog — importing a PDF
 * needs a drop target, and building the project context takes minutes and has to
 * be watched.
 *
 * ONE SCROLLING COLUMN, and NOTHING ON IT IS GATED. Every section is answerable
 * from the moment the page opens, in whatever order suits the reader — someone
 * who has the PDFs to hand and has not yet put the goal into words is doing the
 * ordinary thing, not the wrong thing. The numbering is a suggested reading
 * order, not a sequence of permissions.
 *
 * THERE IS NO EXIT. A project reaches its own screens by finishing this, and by
 * nothing else. That is deliberate, and it is why the name is editable HERE: a
 * mistyped name is most of what an escape hatch would have been used for.
 *
 * EVERY ANSWER IS WRITTEN ON BLUR. This page can be open for as long as reading
 * a handful of papers takes, and a form that must be re-typed after a crash is
 * not persisted at all.
 */
type SourceTabKey = 'file' | 'web'

/** Where one paper has got to, as its row reports it. */
interface PaperState {
  state: 'loading' | 'ready' | 'failed' | 'no-pdf'
  label: string
  /** The stage behind the label, for the tooltip. Null when there is none. */
  stage: string | null
  /** The stage's own words for a refusal, when it gave any. */
  reason: string | null
}

/**
 * A paper whose PDF never arrived, however `retrieve` ended.
 *
 * BOTH OUTCOMES, and that is the whole point of the predicate. `retrieve`
 * refuses when there was nothing to try — no DOI or URL to fetch with — and
 * fails when it tried and got nothing, or when the file the library records has
 * gone. Those are different sentences to tell the reader and the row prints the
 * stage's own words for each; what they share is the only thing this screen asks
 * about, which is whether the paper is here.
 *
 * A predicate matching one outcome silently reported zero the moment a case
 * moved between them, and a paper whose PDF could not be fetched then sat in the
 * list looking exactly like one that had been read cover to cover — matching no
 * state at all, so it fell through to `ready`, which renders nothing.
 *
 * The failure half overlaps `isOutstandingFailure` above, which catches it first
 * and labels it identically via `FETCH_STAGES`; this is what covers the refusal,
 * and covers the failure too rather than depending on the order of two tests.
 *
 * `retrieve` ALONE. A refused extraction is waiting on a schema, which is not a
 * statement about whether the paper arrived, and the stages after retrieval work
 * on a paper that is already here.
 */
const isUnfetched = (j: JobDTO): boolean =>
  j.stage === 'retrieve' &&
  // `skipped` TOO. With no retrieval plugin installed the stage skips rather
  // than refusing — correctly, since nothing was asked — and `skipped` folds
  // into `succeeded` for display. The paper then read as ten green rows for a
  // file the app never tried to fetch, which is the exact failure this stage's
  // own header says it was built to prevent. It has no PDF either way, and
  // that is what this row is reporting.
  (j.outcome === 'refused' || j.outcome === 'skipped' || j.status === 'failed') &&
  !j.dismissed

/**
 * The stages that carry the paper's BYTES here, as opposed to reading them.
 *
 * A break in one of these means the PDF never arrived; a break after them means
 * it arrived and could not be read. The two are different facts and the row says
 * which — the same split the Ingest screen draws, so the two surfaces cannot
 * disagree about one paper.
 */
const FETCH_STAGES = new Set(['retrieve', 'download', 'optimize'])

/**
 * The stages a paper goes through during setup, in the reader's words.
 *
 * Only the ones setup actually plans — the model-calling stages are deferred
 * until the form is finished, so naming them here would describe work that is
 * not happening yet.
 */
const SETUP_STAGE_LABEL: Record<string, string> = {
  retrieve: 'Finding PDF…',
  download: 'Downloading…',
  optimize: 'Downloading…',
  'extract-text': 'Reading text…',
  ocr: 'Reading scan…',
  segment: 'Reading text…',
  embed: 'Indexing…'
}

/**
 * The two ways a paper gets into a project during setup.
 *
 * "Search online" rather than "Search for new papers": inside a section headed
 * "Papers that form the project context", *new* is the only kind there could
 * be, and the word that actually distinguishes this tab from its neighbour is
 * where it looks — this computer, or the internet.
 */
const SOURCE_TABS: readonly { key: SourceTabKey; label: string }[] = [
  { key: 'file', label: 'Import from file' },
  { key: 'web', label: 'Search online' }
]

export function ProjectSetupScreen({
  projectId,
  onOpenWork,
  onFailedCountChanged,
  onFinished
}: {
  projectId: number
  onOpenWork: (workId: number) => void
  onFailedCountChanged: () => void
  onFinished: () => void
}): JSX.Element {
  const project = useAsync<ProjectDTO | null>(() => window.api.getProject(projectId), [projectId])
  const schemas = useAsync<ExtractionSchemaDTO[]>(() => window.api.listSchemas(), [])
  const papers = useAsync<ProjectWorkDTO[]>(
    () => window.api.listProjectWorks(projectId),
    [projectId]
  )

  // The form's own copy, so typing is not a round trip per keystroke. Seeded
  // from the row ONCE — re-seeding on every reload would overwrite what the user
  // is in the middle of typing with what was last saved.
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [questions, setQuestions] = useState<string[]>([''])
  const [schemaIds, setSchemaIds] = useState<number[]>([])
  const seeded = useRef(false)

  const [saveError, setSaveError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  /** A waiting import's `resolve`, while the user answers about a closed Zotero. */
  const [zoteroOffline, setZoteroOffline] = useState<{
    resolve: (proceed: boolean) => void
  } | null>(null)
  const [creatingSchema, setCreatingSchema] = useState(false)
  /**
   * Which way of getting papers is showing.
   *
   * FILE FIRST, deliberately: importing PDFs already in hand is the one that
   * always works, while the search needs a plugin and a browser extension. The
   * default must not be a tab that half of installs cannot use.
   */
  const [sourceTab, setSourceTab] = useState<SourceTabKey>('file')

  useEffect(() => {
    const p = project.data
    if (!p || seeded.current) return
    seeded.current = true
    setName(p.name)
    setGoal(p.goal ?? '')
    // Always a trailing blank row: it is the control that invites the next
    // question, so a project with three saved questions offers a fourth box.
    setQuestions(p.questions.length > 0 ? [...p.questions, ''] : [''])
  }, [project.data])

  // Which schemas this project already has. Read once alongside the rest; the
  // picker is the only thing that changes it afterwards.
  useEffect(() => {
    let alive = true
    void window.api
      .listProjectSchemas(projectId)
      .then((rows) => {
        if (alive) setSchemaIds(rows.map((r) => r.id))
      })
      .catch(() => {
        /* An unreadable attachment list leaves the picker empty, which the user
           can simply re-tick. Nothing here is lost by it. */
      })
    return () => {
      alive = false
    }
  }, [projectId])

  /**
   * Keep the paper list and its counts LIVE while the queue drains.
   *
   * The build button waits on exactly this: a paper that is still being read
   * cannot be read into the project context. Polling would be the wrong tool —
   * the queue already broadcasts on every job transition, which is precisely
   * when these numbers move.
   */
  useEffect(
    () =>
      window.api.onJobsChanged(() => {
        papers.reload()
        project.reload()
      }),
    [papers.reload, project.reload]
  )

  const save = useCallback(
    (patch: { name?: string; goal?: string; questions?: string[]; schemaIds?: number[] }): void => {
      setSaveError(null)
      void window.api
        .updateProjectSetup({ projectId, ...patch })
        .catch((e: unknown) =>
          setSaveError(
            `Could not save that: ${e instanceof Error ? e.message : String(e)}`
          )
        )
    },
    [projectId]
  )

  const trimmedQuestions = useMemo(
    () => questions.map((q) => q.trim()).filter((q) => q !== ''),
    [questions]
  )
  const hasGoal = goal.trim() !== ''
  const hasQuestion = trimmedQuestions.length > 0

  const p = project.data
  const paperCount = papers.data?.length ?? 0
  const processing = p?.processing_count ?? 0
  // READY, not merely present. A paper still moving through the pipeline has no
  // text to read yet, so building over it would produce a context assembled
  // from whichever papers happened to have finished.
  const ready = paperCount > 0 && processing === 0

  const setQuestionAt = (i: number, v: string): void => {
    setQuestions((cur) => {
      const next = [...cur]
      next[i] = v
      // The trailing blank row regrows as soon as the last one is typed into,
      // so there is always exactly one empty box waiting.
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

  /**
   * WHICH paper is still loading, and what it is doing — not just how many.
   *
   * A count alone ("1 still loading") names nothing: the reader cannot tell
   * which of their papers is holding the finish button, whether it is moving,
   * or whether to remove it and carry on. The queue already knows, per paper,
   * so the list says it per paper and the count above becomes a summary of
   * something visible rather than the only thing said.
   *
   * Same derivation as the search rows use — `outcome` decides settled, not
   * `status` — so the two surfaces cannot disagree about one paper.
   */
  const [paperState, setPaperState] = useState<Map<number, PaperState>>(new Map())
  const readPaperState = useCallback(() => {
    void window.api
      .listJobs(projectId)
      .then((jobs) => {
        const next = new Map<number, PaperState>()
        for (const j of jobs) {
          if (j.work_id === null) continue
          const settled = j.outcome !== null
          const live = !settled && (j.status === 'running' || j.status === 'queued' || j.status === 'blocked')
          const broken = isOutstandingFailure(j)
          const cur = next.get(j.work_id)
          // NAMES THE STAGE THAT BROKE, because "could not be read" over a paper
          // whose PDF was never fetched describes work that never started. A
          // fetch that failed and a file that would not parse ask for different
          // things from the reader — one is retryable or wants the PDF by hand,
          // the other is a file already here that is unreadable.
          if (broken) {
            const fetching = FETCH_STAGES.has(j.stage ?? '')
            // NO PDF OUTRANKS A LATER FAILURE. A paper whose fetch failed also
            // fails everything behind it, and those jobs come later in this
            // loop — so an unguarded write moved the row out of "without a
            // PDF" into "N failed", telling the reader to retry a stage that
            // never had a file to work on.
            if (!fetching && cur?.state === 'no-pdf') continue
            next.set(j.work_id, {
              state: fetching ? 'no-pdf' : 'failed',
              label: fetching ? 'Failed to fetch' : 'Could not be read',
              stage: j.stage,
              reason: j.error
            })
            continue
          }
          // A REFUSED FETCH OUTRANKS whatever the rest of the chain says.
          //
          // Refusing cancels every dependent, so those jobs settle `cancelled`
          // and this loop would otherwise read the paper as ready.
          if (isUnfetched(j)) {
            next.set(j.work_id, {
              state: 'no-pdf',
              label: 'Failed to fetch',
              stage: j.stage,
              // The stage writes its words to whichever column its outcome uses:
              // a refusal explains itself in `outcome_note`, a failure in
              // `error`. Reading only the first left the tooltip on every FAILED
              // fetch with nothing but the generic fallback, which is the one
              // case where the reason ("the library file may have been moved")
              // is the entire remedy.
              reason: j.outcome_note ?? j.error
            })
            continue
          }
          if (cur?.state === 'failed' || cur?.state === 'no-pdf') continue
          if (live) {
            // The FIRST live stage wins: jobs arrive in dependency order, so it
            // is the one actually being worked on rather than one still blocked
            // behind it.
            if (cur?.state !== 'loading') {
              next.set(j.work_id, {
                state: 'loading',
                label: SETUP_STAGE_LABEL[j.stage ?? ''] ?? 'Loading…',
                stage: j.stage,
                reason: null
              })
            }
          } else if (cur === undefined) {
            next.set(j.work_id, { state: 'ready', label: 'Ready', stage: null, reason: null })
          }
        }
        setPaperState(next)
      })
      .catch(() => {
        /* An unreadable queue leaves the last known state. Not knowing is not
           evidence that a paper stopped. */
      })
  }, [projectId])

  useEffect(() => {
    readPaperState()
    return window.api.onJobsChanged(readPaperState)
  }, [readPaperState])

  const toggleSchema = (id: number): void => {
    setSchemaIds((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
      save({ schemaIds: next })
      return next
    })
  }

  /** Files dropped or picked. Directories are expanded by main. */
  const acceptFiles = (files: File[]): void => {
    if (files.length === 0) return
    // Electron removed the `File.path` augmentation: a dropped file's real path
    // is reachable only through `webUtils`, bridged here as `getDroppedPath`.
    const paths = files.map((f) => window.api.getDroppedPath(f)).filter((p) => p.length > 0)
    if (paths.length === 0) {
      setImportMsg(
        `Could not open “${files[0].name}”. Try the “Choose file or folder” button instead.`
      )
      return
    }
    setImportBusy(true)
    setImportMsg(null)
    void window.api
      .expandIngestPaths(paths)
      .then(async (pdfs) => {
        if (pdfs.length === 0) {
          // An empty folder and an unreadable one look identical without this.
          setImportMsg(
            `No PDFs found in ${paths.length === 1 ? paths[0] : `those ${paths.length} items`}.`
          )
          return
        }
        await queue(pdfs)
      })
      .catch((e: unknown) => setImportMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setImportBusy(false))
  }

  /**
   * Ask about Zotero before queueing, when this project sends papers to it.
   *
   * The same question the Ingest screen asks, at this screen's own funnel: a
   * paper dropped here is imported exactly like one added there, so it must not
   * quietly miss the user's library because setup happened to be the way in. A
   * project with no connection never sees it.
   */
  const zoteroGate = async (): Promise<boolean> => {
    const conn = await window.api.getZoteroConnection(projectId).catch(() => null)
    if (conn === null || !conn.connected || conn.running) return true
    return new Promise<boolean>((resolve) =>
      setZoteroOffline((pending) => {
        // One open question at a time. Replacing it would strand the first
        // import's `resolve`, leaving that call awaiting for ever.
        if (pending !== null) {
          resolve(false)
          return pending
        }
        return { resolve }
      })
    )
  }

  const queue = async (pdfs: string[]): Promise<void> => {
    if (!(await zoteroGate())) return
    for (const path of pdfs) {
      await window.api.ingest({ projectId, kind: 'pdf', value: path })
    }
    setImportMsg(
      `Added ${pdfs.length} ${pdfs.length === 1 ? 'paper' : 'papers'}. Loading ${pdfs.length === 1 ? 'it' : 'them'} now.`
    )
    papers.reload()
    project.reload()
    onFailedCountChanged()
  }

  /**
   * Take a paper back out of the project.
   *
   * `removeWorkFromProject`, NEVER `deleteWork`: a paper is stored once and
   * shared, and imports dedup by DOI, so erasing it would take the same row out
   * from under any other project holding it. This drops only this project's
   * membership, which is exactly what "I did not mean that one" asks for.
   */
  const removePaper = (workId: number, title: string): void => {
    setImportMsg(null)
    void window.api
      .removeWorkFromProject(projectId, workId)
      .then(() => {
        setImportMsg(`Removed “${title}”.`)
        papers.reload()
        project.reload()
      })
      .catch((e: unknown) => setImportMsg(e instanceof Error ? e.message : String(e)))
  }

  const openPicker = (): void => {
    setImportMsg(null)
    void window.api
      .pickIngestFiles()
      .then(async (paths) => {
        if (paths.length === 0) return
        setImportBusy(true)
        await queue(paths)
      })
      .catch((e: unknown) => setImportMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setImportBusy(false))
  }

  /** Whether anything installed here can search the literature. */
  const [canSearchWeb, setCanSearchWeb] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    void window.api
      .listPlugins()
      .then((list) => {
        if (alive)
          setCanSearchWeb(
            list.plugins.some((pl) => pl.enabled && pl.capabilities.includes('paper-search'))
          )
      })
      .catch(() => {
        if (alive) setCanSearchWeb(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const finish = (): void => {
    setBuilding(true)
    setBuildError(null)
    void window.api
      .finishProjectSetup(projectId)
      .then(() => onFinished())
      .catch((e: unknown) => {
        setBuildError(e instanceof Error ? e.message : String(e))
        setBuilding(false)
      })
  }

  /**
   * Jump to the end of the form — and hide once there is no end to jump to.
   *
   * SCROLLS THE TAB'S OWN SCROLLPORT, found by walking up from this screen
   * rather than by class name. The screen is not the scroll container: the tab
   * shell wraps every route in one, and `window.scrollTo` here moves a document
   * that never scrolls, so the button would do nothing at all.
   *
   * Hidden when everything already fits, and when the reader is at the bottom:
   * a control that cannot change anything is one they learn to ignore.
   */
  const rootRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const scrollportRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let el = rootRef.current?.parentElement ?? null
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if (oy === 'auto' || oy === 'scroll') break
      el = el.parentElement
    }
    scrollportRef.current = el
    if (!el) return

    const read = (): void => {
      // 24px of slack: an exact comparison flickers the button on and off
      // against sub-pixel scroll positions at the very bottom.
      setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 24)
    }
    read()
    el.addEventListener('scroll', read, { passive: true })
    // The form GROWS — a paper lands, a question row appears — so "is there
    // more below" changes without anyone scrolling.
    const ro = new ResizeObserver(read)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [])

  const scrollToBottom = (): void => {
    const el = scrollportRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const steps = [
    { key: 'name', label: 'Name', done: name.trim() !== '' },
    { key: 'goal', label: 'Goal', done: hasGoal },
    { key: 'questions', label: 'Questions', done: hasQuestion },
    { key: 'schemas', label: 'What to collect', done: schemaIds.length > 0, optional: true },
    // SETTLED, not merely present — and `ready` is deliberately the SAME value
    // the build button gates on, so the two can never disagree. Ticking the
    // moment the first PDF was queued declared this step finished while the
    // papers were still downloading, next to a button that refused for exactly
    // that reason.
    { key: 'papers', label: 'Papers', done: ready },
    { key: 'build', label: 'Finish', done: false }
  ]

  return (
    <div className="screen setup" data-testid="screen-setup" ref={rootRef}>
      {/* Bottom-right, over the form. Absent — not disabled — when the page
          already fits or the reader is at the end of it: an arrow that cannot
          move you anywhere is one you stop believing. */}
      {canScrollDown && (
        <button
          type="button"
          className="setup-jump"
          data-testid="setup-jump-bottom"
          aria-label="Go to the bottom of this form"
          data-tip="Jump to the end"
          onClick={scrollToBottom}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 3.5v11" />
            <path d="M5.5 10.5L10 15l4.5-4.5" />
          </svg>
        </button>
      )}
      <div className="setup-layout">
        <div className="setup-column">
          <header className="setup-intro">
            <h1 className="setup-title">Set up this project</h1>
            <p className="setup-lede">
              Tell the app what you are working on. It uses your answers to read every paper you
              add. You can leave this page and come back — your answers are saved as you type.
            </p>
          </header>

          {saveError && (
            <div className="form-error" role="alert" data-testid="setup-save-error">
              {saveError}
            </div>
          )}

          <SetupSection id="name" n={1} title="Project name">
            <input
              className="input setup-input"
              data-testid="setup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                // A blank name is not saved: the row must keep the one it was
                // created with rather than becoming an untitled project.
                if (name.trim()) save({ name: name.trim() })
                else setName(p?.name ?? '')
              }}
            />
          </SetupSection>

          <SetupSection
            id="goal"
            n={2}
            title="What is this project about?"
            help="Describe your topic in your own words, like you would to a colleague."
          >
            <textarea
              className="input textarea setup-input"
              data-testid="setup-goal"
              rows={4}
              autoFocus
              value={goal}
              placeholder="The subject you are working on, and what you want to learn about it."
              onChange={(e) => setGoal(e.target.value)}
              onBlur={() => save({ goal: goal.trim() })}
            />
          </SetupSection>

          <SetupSection
            id="questions"
            n={3}
            title="What questions do you want answered?"
            help="The app asks these of every paper you add. Write one question per box."
          >
            <div className="setup-questions" data-testid="setup-questions">
              {questions.map((q, i) => {
                const last = i === questions.length - 1
                return (
                  <div className="setup-question" key={i}>
                    <span className="setup-question-mark" aria-hidden="true">
                      ?
                    </span>
                    <input
                      className="input setup-input"
                      data-testid={`setup-question-${i}`}
                      value={q}
                      placeholder={
                        i === 0
                          ? 'Something you want to know from every paper.'
                          : 'Add another question…'
                      }
                      onChange={(e) => setQuestionAt(i, e.target.value)}
                      onBlur={() => save({ questions })}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        save({ questions })
                        // Move to the next box, creating it if this was the last
                        // one — Enter commits and opens the next question.
                        const boxes = document.querySelectorAll<HTMLInputElement>(
                          '[data-testid^="setup-question-"]'
                        )
                        boxes[i + 1]?.focus()
                      }}
                    />
                    {/* Never on the trailing blank: there is nothing to remove,
                        and a live control beside an empty box invites a press
                        that would delete the row the user is about to type in. */}
                    <button
                      type="button"
                      className="setup-question-remove"
                      data-testid={`setup-question-remove-${i}`}
                      aria-label={`Remove question ${i + 1}`}
                      data-tip="Remove this question"
                      style={last && q.trim() === '' ? { visibility: 'hidden' } : undefined}
                      disabled={last && q.trim() === ''}
                      onClick={() => removeQuestionAt(i)}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </SetupSection>

          <SetupSection
            id="schemas"
            n={4}
            title="What numbers should the app collect?"
            help="A schema is a list of values to pull out of every paper, so you can compare them side by side. You can change this later."
          >
            <DataView
              state={schemas}
              isEmpty={(d) => d.length === 0}
              skeleton={<div className="empty">Loading schemas…</div>}
              empty={
                /* The SHORTFALL and the reassurance together. Stating only the
                   first reads as a blocker on a page with no exit; stating only
                   the second lets someone finish setup and wonder for a week why
                   no values ever appeared. */
                <div className="setup-noschema" data-testid="setup-no-schemas">
                  <p className="setup-noschema-warn">
                    You have no schemas yet. Your papers will still be read and summarised, but no
                    numbers will be collected from them.
                  </p>
                  <p className="setup-noschema-ok">
                    That is fine for now. Most people add one later, once they have read a few
                    papers and know what is worth collecting. Nothing needs redoing when you do.
                  </p>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-testid="setup-create-schema"
                    onClick={() => setCreatingSchema(true)}
                  >
                    Create a schema
                  </button>
                </div>
              }
            >
              {(list) => (
                <>
                  <div className="wizard-schemas" data-testid="setup-schemas">
                    {list.map((s) => {
                      const on = schemaIds.includes(s.id)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          className={`wizard-schema ${on ? 'is-on' : ''}`}
                          data-testid={`setup-schema-${s.id}`}
                          aria-pressed={on}
                          onClick={() => toggleSchema(s.id)}
                        >
                          <span className="wizard-schema-check" aria-hidden="true">
                            ✓
                          </span>
                          <span className="wizard-schema-text">
                            <span className="wizard-schema-name">{s.name}</span>
                            {s.description && (
                              <span className="wizard-schema-desc">{s.description}</span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {/* Only when none is ticked — the exception, not the state. */}
                  {schemaIds.length === 0 && (
                    <p className="setup-hint" data-testid="setup-schema-none-picked">
                      Nothing picked, so no numbers will be collected. That is fine for now.
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn-link setup-newschema"
                    data-testid="setup-create-schema"
                    onClick={() => setCreatingSchema(true)}
                  >
                    make a new schema
                  </button>
                </>
              )}
            </DataView>
          </SetupSection>

          <SetupSection
            id="papers"
            n={5}
            title="Add your starting papers"
            help="Pick a few papers that give the background for your topic. The app reads these first, then uses them to make sense of everything you add later."
          >
            <>
                {/* EVERY paper added here becomes part of the context. Said
                    before the import, not after it, because it is the reason the
                    section exists and it is what makes the cost predictable. */}
                <p className="setup-hint setup-hint-strong">
                  Every paper you add here gets read by the AI when you finish. A few good ones work
                  better than a lot of them.
                </p>

                {/* `ingest` CARRIES THE SCOPE, it does not name a screen.
                    The widgets below are the Papers screen's own, and their
                    ~390 rules are written under `.ingest` — mounting them
                    without it renders the search panel as unstyled browser
                    inputs, which shipped once and looked broken. The class is
                    on a wrapper rather than duplicated into the components so
                    there stays exactly one copy of those rules. */}
                <div className="ingest setup-import">
                  {/* ONE AT A TIME, on the same segmented switch the Papers
                      screen uses. Stacked, the two surfaces read as a sequence
                      — drop your files, THEN search — when they are two answers
                      to one question, and the drop zone's empty expanse pushed
                      the search most of a screen down.

                      The strip is drawn only when there is a choice to make: a
                      one-tab switch is chrome that decides nothing. */}
                  {canSearchWeb === true && (
                    <div className="ing-segment" role="tablist" data-testid="setup-source-tabs">
                      {SOURCE_TABS.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          role="tab"
                          aria-selected={t.key === sourceTab}
                          className={`ing-seg-btn ${t.key === sourceTab ? 'is-active' : ''}`}
                          data-testid={`setup-source-${t.key}`}
                          onClick={() => {
                            setSourceTab(t.key)
                            setImportMsg(null)
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* `canSearchWeb !== true` forces the file tab: searching the
                      literature happens inside the user's own browser through a
                      plugin, and with none installed the words name nothing
                      this install can do — so the tab is ABSENT, not disabled,
                      and its panel can never be the one showing. */}
                  {sourceTab === 'file' || canSearchWeb !== true ? (
                    <PdfDropZone
                      busy={importBusy}
                      onFiles={acceptFiles}
                      onPick={openPicker}
                      compact
                    />
                  ) : (
                    <div className="ing-card">
                      <WebSearchPanel
                        projectId={projectId}
                        onQueued={() => {
                          papers.reload()
                          project.reload()
                          onFailedCountChanged()
                        }}
                      />
                    </div>
                  )}
                </div>

                {importMsg && (
                  <p className="setup-msg" role="status" data-testid="setup-import-msg">
                    {importMsg}
                  </p>
                )}

                <PaperList
                  papers={papers.data ?? []}
                  processing={processing}
                  onOpenWork={onOpenWork}
                  onRemove={removePaper}
                  state={paperState}
                />
            </>
          </SetupSection>

          <SetupSection
            id="build"
            n={6}
            title="Finish setup"
            help="The AI reads the papers you added and writes up the background for your topic. This takes a few minutes."
          >
            {buildError && (
              <div className="form-error" role="alert" data-testid="setup-build-error">
                {buildError}
              </div>
            )}

            {building ? (
              <BuildProgress count={paperCount} />
            ) : (
              <button
                type="button"
                className="btn btn-primary setup-finish"
                data-testid="setup-finish"
                disabled={!ready}
                data-tip={
                  paperCount === 0
                    ? 'Add at least one paper above first.'
                    : processing > 0
                      ? `Waiting for ${processing} ${processing === 1 ? 'paper' : 'papers'} to finish loading.`
                      : undefined
                }
                onClick={finish}
              >
                {/* The COST, named before it is spent — but only once there is
                    one. "Read 0 papers" describes nothing and reads as broken;
                    the button is disabled in that state anyway, and its tip
                    says what is missing. */}
                {paperCount === 0
                  ? 'Read the papers and open the project'
                  : `Read ${paperCount} ${paperCount === 1 ? 'paper' : 'papers'} and open the project`}
              </button>
            )}
          </SetupSection>
        </div>

        <SetupRail steps={steps} />
      </div>

      {creatingSchema && (
        <SchemaCreateModal
          onClose={() => setCreatingSchema(false)}
          onCreated={(s) => {
            setCreatingSchema(false)
            schemas.reload()
            // Ticked on arrival: creating one from this page IS choosing it, and
            // making the user then find it in the list would be asking twice.
            setSchemaIds((cur) => {
              const next = [...cur, s.id]
              save({ schemaIds: next })
              return next
            })
          }}
        />
      )}

      {/* A paper dropped here is imported exactly like one added from the Ingest
          screen, so it gets the same question when Zotero is connected but
          closed. Dismissing it cancels the import rather than queueing papers
          that would silently miss the user's library. */}
      {zoteroOffline && (
        <ZoteroOfflineModal
          onRetry={async () => {
            const up = await window.api.isZoteroRunning().catch(() => false)
            if (up) {
              zoteroOffline.resolve(true)
              setZoteroOffline(null)
            }
            return up
          }}
          onDisable={async () => {
            await window.api.disconnectZotero(projectId)
          }}
          onClose={() => {
            void window.api
              .getZoteroConnection(projectId)
              .then((c) => zoteroOffline.resolve(!c.connected))
              .catch(() => zoteroOffline.resolve(false))
              .finally(() => setZoteroOffline(null))
          }}
        />
      )}
    </div>
  )
}

/** One numbered block of the form. */
function SetupSection({
  id,
  n,
  title,
  help,
  children
}: {
  id: string
  n: number
  title: string
  help?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section
      className="setup-section"
      id={`setup-${id}`}
      data-testid={`setup-section-${id}`}
    >
      <div className="setup-section-head">
        <span className="setup-section-num" aria-hidden="true">
          {n}
        </span>
        <div className="setup-section-text">
          <h2 className="setup-section-title">{title}</h2>
          {help && <p className="setup-section-help">{help}</p>}
        </div>
      </div>
      <div className="setup-section-body">{children}</div>
    </section>
  )
}

/** Where the reader is in the form, and what is left. */
function SetupRail({
  steps
}: {
  steps: { key: string; label: string; done: boolean; optional?: boolean }[]
}): JSX.Element {
  return (
    <nav className="setup-rail" data-testid="setup-rail" aria-label="Setup progress">
      {steps.map((s, i) => (
        <a
          key={s.key}
          className={`setup-rail-step ${s.done ? 'is-done' : ''}`}
          href={`#setup-${s.key}`}
          data-testid={`setup-rail-${s.key}`}
        >
          <span className="setup-rail-dot" aria-hidden="true">
            {s.done ? '✓' : i + 1}
          </span>
          <span className="setup-rail-label">{s.label}</span>
          {/* Only the exception: most of these must be answered, so saying
              nothing is what marks them as required. */}
          {s.optional && <span className="setup-rail-optional">optional</span>}
        </a>
      ))}
    </nav>
  )
}

/**
 * The papers imported so far, and whether they are ready to be read.
 *
 * The counts come from the project row, which the queue refreshes on every job
 * transition — so this tracks the pipeline without a second subscription of its
 * own to keep in step.
 */
function PaperList({
  papers,
  processing,
  onOpenWork,
  onRemove,
  state
}: {
  papers: ProjectWorkDTO[]
  processing: number
  onOpenWork: (workId: number) => void
  onRemove: (workId: number, title: string) => void
  state: Map<number, PaperState>
}): JSX.Element | null {
  // BOTH COUNTED HERE, from the very map the rows render, so the summary and
  // the rows cannot disagree — and so no paper is counted twice.
  //
  // `failed_count` is the project row's `status IN ('failed','error')`, which
  // does not see a refused fetch and DOES see a fetch that failed. Mixing it
  // with a count derived from the rows put a paper whose PDF could not be
  // fetched into both pills at once, so nine papers reported ten problems.
  const unfetched = papers.filter((pw) => state.get(pw.work.id)?.state === 'no-pdf').length
  const unreadable = papers.filter((pw) => state.get(pw.work.id)?.state === 'failed').length
  if (papers.length === 0) return null
  return (
    <div className="setup-papers" data-testid="setup-papers">
      <div className="setup-papers-head">
        <span className="setup-papers-count">
          {papers.length} {papers.length === 1 ? 'paper' : 'papers'}
        </span>
        {/* Both are EXCEPTIONS: a corpus sitting ready says nothing here. */}
        {processing > 0 && (
          <span
            className="badge badge-warn"
            data-testid="setup-papers-processing"
            data-tip="Each paper is downloaded and read before it can be used. This usually takes under a minute."
          >
            {processing} still loading
          </span>
        )}
        {unreadable > 0 && (
          <span
            className="badge badge-danger"
            data-testid="setup-papers-failed"
            data-tip="These could not be read. You can carry on without them and try again later from the Papers screen."
          >
            {unreadable} failed
          </span>
        )}
        {/* ITS OWN PILL, never folded into the failed count. A paper the
            retriever declined has not failed, and the two ask for different
            things: one is a broken stage to retry, the other is a PDF to supply
            or a paper to drop. Only when there are any. */}
        {unfetched > 0 && (
          <span
            className="badge badge-warn setup-papers-unfetched"
            data-testid="setup-papers-unfetched"
            data-tip="The PDF could not be fetched for these. They will be read from their abstract only — you can add the PDFs yourself from the Papers screen, or remove them and carry on."
          >
            {unfetched} without a PDF
          </span>
        )}
      </div>
      <ul className="setup-paper-list">
        {papers.map((pw) => (
          <li key={pw.work.id} className="setup-paper">
            <button
              type="button"
              className="setup-paper-btn"
              data-testid={`setup-paper-${pw.work.id}`}
              onClick={() => onOpenWork(pw.work.id)}
            >
              <span className="setup-paper-title"><RichText text={pw.work.title} /></span>
              {pw.work.publication_year !== null && (
                <span className="setup-paper-year mono">{pw.work.publication_year}</span>
              )}
              {/* THE EXCEPTION ONLY. A paper that is ready says nothing — it is
                  what every row is supposed to be, and a green "Ready" on eight
                  of nine rows is what makes the ninth invisible. */}
              {(() => {
                const st = state.get(pw.work.id)
                if (st === undefined || st.state === 'ready') return null
                return (
                  <span
                    className={`setup-paper-state is-${st.state}`}
                    data-testid={`setup-paper-state-${pw.work.id}`}
                    data-tip={
                      st.state === 'no-pdf'
                        ? // The REASON the fetch came back empty, when the stage
                          // gave one — "the publisher requires a subscription"
                          // and "there is no identifier to fetch a PDF with" ask
                          // for completely different things from the reader, and
                          // one sentence covering both would help with neither.
                          `${st.reason ?? 'The PDF for this paper could not be fetched.'} You can add the PDF yourself from the Papers screen, or remove this paper and carry on — the project context is built from the rest.`
                        : st.state === 'failed'
                          ? 'This paper could not be read. You can remove it and carry on — the project context is built from the rest.'
                          : `This paper is still being prepared${st.stage ? ` (${st.stage})` : ''}. The finish button waits for it.`
                    }
                  >
                    {st.state === 'loading' && (
                      <span className="setup-paper-spinner" aria-hidden="true" />
                    )}
                    {/* Never colour alone. The failed and no-PDF pills are told
                        apart by their glyph as well as their tint, so the two
                        exceptions do not collapse into "something is wrong". */}
                    {st.state === 'no-pdf' && (
                      <span className="setup-paper-state-mark" aria-hidden="true">
                        ⃠
                      </span>
                    )}
                    {st.label}
                  </span>
                )
              })()}
            </button>
            {/* TAKES IT OUT OF THIS PROJECT, and does not erase the paper. A
                paper is stored once and shared, so a delete here could take one
                out from under a project that has been reading it for months.
                No arm-and-confirm: nothing is destroyed, and the paper can be
                added again from the same search it came from. */}
            <button
              type="button"
              className="setup-paper-remove"
              data-testid={`setup-paper-remove-${pw.work.id}`}
              aria-label={`Remove ${plainText(pw.work.title)} from this project`}
              data-tip="Remove this paper from the project. The paper itself is kept."
              onClick={() => onRemove(pw.work.id, pw.work.title)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The build, while it runs.
 *
 * NO PERCENTAGE and no estimate. The build calls the model once per paper,
 * serialized, and how long one takes depends on the paper and the provider —
 * a bar that guessed would spend most of its time being wrong, and a stalled
 * one reads as a crash. What it can say honestly is what is happening, how much
 * of it there is, and that leaving is safe.
 */
function BuildProgress({ count }: { count: number }): JSX.Element {
  return (
    <div className="setup-building" data-testid="setup-building" role="status" aria-live="polite">
      <span className="setup-building-spinner" aria-hidden="true" />
      <div className="setup-building-text">
        <span className="setup-building-title">
          Reading {count} {count === 1 ? 'paper' : 'papers'}…
        </span>
        <span className="setup-building-hint">
          This can take a few minutes. Your project opens on its own when it is done.
        </span>
      </div>
    </div>
  )
}
