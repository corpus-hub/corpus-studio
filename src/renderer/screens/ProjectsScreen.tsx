import { useEffect, useState } from 'react'
import type { ProjectDTO } from '@shared/types'
import type { ArchiveInfoDTO, SharedProjectDTO } from '@shared/contract'
import { SharedGlyph } from '../components/SyncStatusIcon'
import { SharingModal } from '../components/SharingModal'
import { useAsync } from '../lib/useAsync'
import { DataView } from '../components/States'
import { Modal } from '../components/ui'
import { fmtBytes } from '../lib/format'

function categorySubtitle(p: ProjectDTO): string {
  if (p.category && p.category.trim()) return p.category
  // The GOAL, when the project has one — it is the sentence the user wrote to
  // say what this collection is for, and it is a better subtitle than a clause
  // sliced out of the composed description, which starts with that same goal
  // and then runs into the enumerated questions.
  if (p.goal && p.goal.trim()) return p.goal.split(/[·.\n]/)[0].trim()
  if (p.description && p.description.trim()) {
    // Fallback to the description's first clause.
    return p.description.split(/[·.\n]/)[0].trim()
  }
  return ''
}

export function ProjectsScreen({
  onOpenProject,
  onProjectsChanged
}: {
  onOpenProject: (id: number) => void
  /**
   * Tell the shell a project was created or imported.
   *
   * It keeps its own copy of the list to decide whether a project is still in
   * its setup questionnaire, and a project created here is one it has never
   * seen — so without this it would open the new project's ordinary screens
   * over a corpus that does not exist yet.
   *
   * The ROW goes with it when there is one. The shell renders the project's
   * chrome — its name in the sidebar above all — on the same frame it navigates
   * in, which is before any re-read can answer.
   */
  onProjectsChanged: (created?: ProjectDTO) => void
}): JSX.Element {
  const state = useAsync<ProjectDTO[]>(() => window.api.listProjects(), [])
  const [wizard, setWizard] = useState(false)
  /**
   * Which projects are shared, and whether each is in step.
   *
   * `ProjectDTO` is deliberately NOT extended with this: shared-ness is one
   * plugin's interpretation of a project, and the frozen contract carries no
   * plugin state. An empty answer — the fresh-install case — renders nothing.
   */
  const [shares, setShares] = useState<Map<number, SharedProjectDTO>>(new Map())
  /**
   * Whether sharing is available AT ALL on this install.
   *
   * The plugin is off on every fresh install, and while it is off the words
   * "share", "invitation" and "relay" mean nothing here — so the entry point is
   * absent rather than present-and-refusing. A control that exists only to
   * explain that it cannot work is a control that spends the row on nothing.
   *
   * ASKED AS A CAPABILITY, never as an id. This file must not know the NAME of
   * the plugin answering it: the question the button is asking is "can anything
   * installed here share a project?", and gating on the name would mean a second
   * sharing plugin, or the same one renamed, rendered no entry point and nothing
   * on screen to say why. `capabilities` is derived
   * in main from the verbs the loaded module actually offers, so the button is
   * present exactly when the calls behind it exist.
   */
  const [sharingOn, setSharingOn] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  /**
   * True when the last attempt to read the sharing state THREW.
   *
   * "No project is shared" and "we could not find out" are different answers,
   * and rendering the second as the first is the worse mistake by far: every
   * card loses its Shared mark and its out-of-sync warning, so a project that
   * is still exchanging rows with a colleague looks private and settled. The
   * cards keep showing nothing — a share this screen has not read is a share it
   * must not draw — and the header says the state is unread instead.
   */
  const [sharingUnread, setSharingUnread] = useState(false)
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void window.api
        .listShares()
        .then((rows) => {
          if (!alive) return
          setShares(new Map(rows.map((r) => [r.projectId, r])))
          setSharingUnread(false)
        })
        .catch(() => {
          if (!alive) return
          setShares(new Map())
          setSharingUnread(true)
        })
      void window.api
        .listPlugins()
        .then((ps) => {
          if (alive)
            setSharingOn(
              ps.plugins.some((p) => p.enabled && p.capabilities.includes('project-sharing'))
            )
        })
        .catch(() => {
          if (!alive) return
          setSharingOn(false)
          setSharingUnread(true)
        })
    }
    read()
    const off = window.api.onSharesChanged(read)
    return () => {
      alive = false
      off()
    }
  }, [])
  /**
   * Keep the "N processing" counts LIVE while the queue drains.
   *
   * The whole reason that count is on this screen is to watch several projects
   * being processed at once, and a number read once at mount cannot do that —
   * it would be stale within seconds and would still say "12 processing" over a
   * corpus that had finished. The queue already broadcasts on every job
   * transition, which is exactly the event that moves these numbers.
   *
   * `state.reload()` re-reads the whole project list rather than patching the
   * counts, so every other stat on the card (failed, review, extracted) tracks
   * the same events without a second subscription to keep in step.
   */
  useEffect(() => window.api.onJobsChanged(() => state.reload()), [state.reload])

  const reloadShares = (): void => {
    void window.api
      .listShares()
      .then((rows) => {
        setShares(new Map(rows.map((r) => [r.projectId, r])))
        setSharingUnread(false)
      })
      .catch(() => {
        setShares(new Map())
        setSharingUnread(true)
      })
    state.reload()
  }

  return (
    <div className="screen dashboard" data-testid="screen-projects">
      <div className="dash-header">
        <div className="dash-header-text">
          <h1 className="dash-title">Research projects</h1>
        </div>
        {/* Only once the plugin is on. Sharing is not a thing this app does by
            default, and an install that has never configured a relay has no use
            for the word. */}
        {sharingOn && (
          <button
            type="button"
            className="btn btn-secondary dash-share"
            data-testid="open-sharing"
            data-tip="Join a project a colleague has shared with you, or share one of yours with them."
            onClick={() => setSharingOpen(true)}
          >
            <SharedGlyph />
            Shared projects
          </button>
        )}
        {/* Shown whether or not the button beside it is: with no answer, the
            absence of sharing marks on the cards below is not evidence, and the
            reader is the only one who can tell it apart from a quiet corpus. */}
        {sharingUnread && (
          <div
            className="dash-share-unread"
            data-testid="shares-unreadable"
            role="alert"
            data-tip="If any of these projects are shared, they may still be syncing. Reopening this screen tries again."
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 2.6L18 16.6H2z" />
              <path d="M10 8v3.6" />
              <path d="M10 14.1v.1" />
            </svg>
            Sharing state could not be read, so no project below is marked as shared.
          </div>
        )}
      </div>

      {/* With projects, the ghost add-card leads the grid and needs no prose.
          With none, that card is the whole screen and says nothing about what
          the app is for — so the cold start gets an orientation panel instead,
          which carries the same single action rather than duplicating it. */}
      <DataView state={state} isEmpty={(d) => d.length === 0} empty={<FirstRun onCreate={() => setWizard(true)} />}>
        {(projects) => (
          <div className="project-grid" data-testid="project-grid">
            {/* FIRST, not last: creating a project is the one action available
                here, and trailing it behind the list buried it further with
                every project added. */}
            <button
              type="button"
              className="project-card project-card-add"
              data-testid="new-project-card"
              onClick={() => setWizard(true)}
            >
              <span className="project-card-add-glyph" aria-hidden="true">
                +
              </span>
              <span className="project-card-add-label">New research project</span>
            </button>
            {projects.map((p) => {
              const subtitle = categorySubtitle(p)
              const share = shares.get(p.id) ?? null
              // A project whose questionnaire is unfinished. Its card leads back
              // into the form rather than into screens that would read a corpus
              // it has not got, and it says which so the click is not a surprise.
              const inSetup = p.setup_state === 'onboarding'
              const failed = share?.state === 'failed' || share?.state === 'needs-credentials'
              // Out of step is anything not settled — but NOT a cycle that is
              // merely running. A card that flashed a warning every ten seconds
              // while the sync worked correctly would teach the reader to ignore
              // the one time it means something.
              const outOfSync = share !== null && !share.inSync && !failed && share.state !== 'syncing'
              return (
                <button
                  key={p.id}
                  type="button"
                  className={
                    'project-card' +
                    (share ? ' is-shared' : '') +
                    (outOfSync ? ' is-out-of-sync' : '') +
                    (failed ? ' is-sync-failed' : '') +
                    (inSetup ? ' is-in-setup' : '')
                  }
                  data-testid={`project-card-${p.id}`}
                  data-tip={
                    inSetup
                      ? 'This project is not set up yet. Click to finish setting it up.'
                      : undefined
                  }
                  onClick={() => onOpenProject(p.id)}
                >
                  <div className="project-card-head">
                    <h3 className="project-card-name">{p.name}</h3>
                    {subtitle && <div className="project-card-field">{subtitle}</div>}
                    {/* An EXCEPTION, and one the reader must act on: this
                        project cannot be used until the form is finished. */}
                    {inSetup && (
                      <div className="project-setup" data-testid={`project-setup-${p.id}`}>
                        <span className="badge badge-warn">Setup unfinished</span>
                      </div>
                    )}
                    {share && (
                      <div className="project-shared" data-testid={`project-shared-${p.id}`}>
                        <SharedGlyph />
                        Shared
                        {/* The CHIP is spent only on the exception. "Shared" is
                            chrome; "Not in sync" is the thing the reader has to
                            do something about. */}
                        {outOfSync && <span className="badge badge-warn">Not in sync</span>}
                        {failed && <span className="badge badge-danger">Sync failed</span>}
                      </div>
                    )}
                  </div>

                  {/* NO STATISTICS while the project is being set up. Every
                      figure below measures work over a corpus, and this project
                      has not chosen one yet — "0 papers · no papers yet" is not
                      a finding about it, it is the questionnaire being
                      unfinished, which the badge above already says. */}
                  {inSetup ? (
                    <div className="project-card-setup-note" data-testid={`project-setup-note-${p.id}`}>
                      Click to finish setting it up.
                    </div>
                  ) : (
                  <>
                  {/* The project's SIZE, and nothing beside it. Everything below
                      is measured against this number, so it is the one figure
                      that is always present. */}
                  <div className="project-card-size">
                    <span
                      className="project-card-size-value"
                      data-testid={`project-stat-papers-${p.id}`}
                      data-work-count={p.work_count}
                    >
                      <span data-testid={`project-work-count-${p.id}`}>{p.work_count}</span>
                    </span>
                    <span className="project-card-size-label">
                      {p.work_count === 1 ? 'paper' : 'papers'}
                    </span>
                    {p.extracted_count > 0 && (
                      <span
                        className="project-card-size-note"
                        data-testid={`project-stat-extracted-${p.id}`}
                      >
                        {p.extracted_count} extracted
                      </span>
                    )}
                  </div>

                  <ProjectExceptions p={p} />

                  {p.work_count > 0 ? (
                    <ReadingProgress p={p} />
                  ) : (
                    <div
                      className="project-card-unstarted mono"
                      data-testid={`project-unstarted-${p.id}`}
                    >
                      no papers yet
                    </div>
                  )}
                  </>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </DataView>

      {sharingOpen && (
        <SharingModal
          projects={state.data ?? []}
          shares={[...shares.values()]}
          onClose={() => setSharingOpen(false)}
          onChanged={reloadShares}
        />
      )}

      {wizard && (
        <NewProjectWizard
          onClose={() => setWizard(false)}
          onCreated={(p) => {
            setWizard(false)
            state.reload()
            // BEFORE opening it, and WITH the row: the shell decides which
            // screen a project gets — and what to call it — from a list that
            // does not yet contain this one.
            onProjectsChanged(p)
            onOpenProject(p.id)
          }}
        />
      )}
    </div>
  )
}

/**
 * The things that are WRONG here, and nothing else.
 *
 * A project in good order renders an empty row and says nothing — the whole
 * value of these pills is that seeing one means somewhere to go. "0 need
 * review" next to a green "all retrieved" would spend the reader's attention
 * telling them what they already assumed, and would bury the one card that
 * really is stuck among nineteen that are not.
 *
 * FAILED means a job that FAILED, not a paper that is thin. A pill counted
 * papers with no full text, and that is a property of the source — a paper only
 * ever published as an abstract is not a fault and nothing here can fix it, so
 * announcing it on the card asks the reader to act on something they cannot.
 * The queue's own row already says what a given paper was read from.
 */
function ProjectExceptions({ p }: { p: ProjectDTO }): JSX.Element | null {
  const items: Array<{ key: string; tone: string; glyph: string; text: string; tip: string }> = []
  // FIRST, and the one pill here that is not a fault.
  //
  // It earns its place under the badge rule the same way a failure count does:
  // the reader has to act on it — by waiting, and by not starting more work
  // while this project has the queue. The whole point of showing it on THIS
  // screen is that the queue is shared, so a project sitting still is
  // explained by the neighbour that is moving, and that is only legible with
  // every project in view at once.
  if (p.processing_count > 0) {
    items.push({
      key: 'processing',
      tone: 'busy',
      glyph: '◐',
      text: `${p.processing_count} processing`,
      tip:
        `${p.processing_count} ${p.processing_count === 1 ? 'paper is' : 'papers are'} being ` +
        'processed or waiting their turn. The queue is shared across every project, so these ' +
        'run alongside any other project\u2019s papers rather than each project having its own.'
    })
  }
  if (p.failed_count > 0) {
    items.push({
      key: 'failed',
      tone: 'danger',
      glyph: '✕',
      text: `${p.failed_count} failed`,
      tip: `${p.failed_count} ${p.failed_count === 1 ? 'paper' : 'papers'} whose processing failed and has not been dismissed. Open the project's queue to retry.`
    })
  }
  // RECORDS, NOT PAPERS — the one pill here that does not count papers, and it
  // has to say so in its own text.
  //
  // `review_count` is `countReviewQueue`, a COUNT(*) over `fact`: one row per
  // extracted VALUE that the queue flags, which is exactly what the Review
  // screen lists and calls a "record". Every other pill on this card counts
  // papers, so a bare number inherited that reading — a corpus of 22 papers
  // advertised "152 to review", a figure larger than the whole project, over 5
  // papers that had actually been extracted. Read as papers it is impossible,
  // and the natural conclusion is that the number is broken rather than that it
  // measures something else.
  //
  // Naming the unit is the fix, NOT dividing by paper: a reader who has to make
  // 152 decisions should be told 152, and the queue really does hold one row per
  // value. So the pill states both — how many records, and how few papers they
  // came from, which is the part that makes the size make sense.
  if (p.review_count > 0) {
    items.push({
      key: 'review',
      tone: 'review',
      glyph: '!',
      text: `${p.review_count} ${p.review_count === 1 ? 'record' : 'records'} to review`,
      tip:
        `${p.review_count} extracted ${p.review_count === 1 ? 'value needs' : 'values need'} ` +
        'a second look — flagged as inferred, conflicting, or failing a check, plus a random ' +
        'sample of the auto-validated ones. These are individual VALUES, not papers: one paper ' +
        'usually contributes many. Open Review to decide on them.'
    })
  }
  if (items.length === 0) return null
  return (
    <div className="project-card-flags" data-testid={`project-flags-${p.id}`}>
      {items.map((it) => (
        <span
          key={it.key}
          className={`project-flag project-flag-${it.tone}`}
          data-testid={`project-flag-${it.key}-${p.id}`}
          data-tip={it.tip}
        >
          <span className="project-flag-glyph" aria-hidden="true">
            {it.glyph}
          </span>
          {it.text}
        </span>
      ))}
    </div>
  )
}

/**
 * How far through the reading this project is.
 *
 * A bar is kept, but of a DIFFERENT quantity: the old one filled with
 * `ranked_count / work_count`, which is near-always 1 because ranking happens
 * to every paper on ingest — a full bar over a project barely begun. Inclusion
 * status only advances when a person decides something, so this one is honest
 * about being at the start when it is, and reaching the end means the corpus
 * has actually been triaged.
 *
 * Segmented rather than a single fill because the middle state matters: papers
 * opened and left uncertain are work in flight, and collapsing them into either
 * end would misreport it.
 */
function ReadingProgress({ p }: { p: ProjectDTO }): JSX.Element {
  const total = p.work_count || 1
  const seg = (n: number): string => `${(n / total) * 100}%`
  const parts = [
    { key: 'decided', n: p.decided_count, label: 'decided' },
    { key: 'undecided', n: p.undecided_count, label: 'in progress' },
    { key: 'unread', n: p.unread_count, label: 'unread' }
  ].filter((s) => s.n > 0)
  return (
    <div className="project-card-reading" data-testid={`project-reading-${p.id}`}>
      <div
        className="project-reading-track"
        role="img"
        aria-label={parts.map((s) => `${s.n} ${s.label}`).join(', ')}
      >
        {parts.map((s) => (
          <span
            key={s.key}
            className={`project-reading-seg project-reading-${s.key}`}
            style={{ width: seg(s.n) }}
          />
        ))}
      </div>
      <div className="project-reading-legend">
        {parts.map((s) => (
          <span key={s.key} className={`project-reading-key project-reading-key-${s.key}`}>
            <span className="project-reading-swatch" aria-hidden="true" />
            {s.n} {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * The cold start. A library with no projects is the correct state of a new
 * install, and it has to read as "nothing here yet, here is the first move"
 * rather than as a screen that failed to load.
 *
 * It names the one action (create a project) and then states what follows it,
 * because the second step — getting papers in — is where the app's actual work
 * begins and is not discoverable from an empty dashboard. The steps after the
 * first are DESCRIPTIONS, not controls: they live inside a project that does
 * not exist yet, and a button that cannot do its job is worse than a sentence.
 */
function FirstRun({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="first-run" data-testid="first-run">
      <div className="first-run-body">
        <h2 className="first-run-title">Your library is empty</h2>
        <p className="first-run-lede">
          Corpus Studio keeps a body of literature, the citations between the papers, and every
          analysis run over them — with the model, prompt and evidence recorded for each result.
          Nothing leaves this machine.
        </p>

        <ol className="first-run-steps">
          <li className="first-run-step">
            <span className="first-run-step-num" aria-hidden="true">
              1
            </span>
            <div className="first-run-step-text">
              <span className="first-run-step-title">Create a project</span>
              <span className="first-run-step-hint">
                A question you are pursuing. Papers are shared across projects; relevance, ranking
                and notes belong to one.
              </span>
            </div>
          </li>
          <li className="first-run-step">
            <span className="first-run-step-num" aria-hidden="true">
              2
            </span>
            <div className="first-run-step-text">
              <span className="first-run-step-title">Add papers</span>
              <span className="first-run-step-hint">
                Search the literature, drop in PDFs you already have, or paste a DOI, PMID or arXiv
                id. Each lands in the project&rsquo;s queue and is read from end to end.
              </span>
            </div>
          </li>
          <li className="first-run-step">
            <span className="first-run-step-num" aria-hidden="true">
              3
            </span>
            <div className="first-run-step-text">
              <span className="first-run-step-title">Extract and review</span>
              <span className="first-run-step-hint">
                Run an extraction schema over the corpus, then check every claim against the span of
                the PDF it came from.
              </span>
            </div>
          </li>
        </ol>

        <div className="first-run-actions">
          <button
            type="button"
            className="btn btn-primary first-run-cta"
            data-testid="first-run-create"
            onClick={onCreate}
          >
            Create your first project
          </button>
        </div>
      </div>
    </div>
  )
}

function NewProjectWizard({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (p: ProjectDTO) => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * The archive to be imported, once one has been chosen and read.
   *
   * The wizard has TWO modes and shows one at a time. An archive names its own
   * project and brings its own papers, so leaving the name field on screen
   * beside it would offer a decision the import is about to ignore.
   */
  const [archive, setArchive] = useState<ArchiveInfoDTO | null>(null)

  /** Choose a file and read what it holds. Nothing is written yet. */
  const pickArchive = async (): Promise<void> => {
    setError(null)
    try {
      const info = await window.api.pickProjectArchive()
      // null means the picker was dismissed — not a failure, and nothing to say
      // about it. A file that is not an archive throws, and that message is
      // worth showing.
      if (info) setArchive(info)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const runImport = async (): Promise<void> => {
    if (!archive) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.importProjectArchive(archive.path)
      const created = await window.api.getProject(res.project_id)
      if (created) onCreated(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  /**
   * Create the project and hand it straight to its setup page.
   *
   * A NAME AND NOTHING ELSE. What the project is for, what it asks, what to
   * extract and which papers form its context are all asked on that page, where
   * there is room to import a PDF and to watch a context being built — neither
   * of which a dialog can hold.
   *
   * The row is written NOW, before any of those answers exist, so that they have
   * somewhere to be saved as they are typed. That is what lets the page be left
   * and come back to.
   */
  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      setError('A project name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const p = await window.api.createProject({
        name: name.trim(),
        description: '',
        onboarding: true
      })
      onCreated(p)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // The IMPORT mode. Replaces the form rather than sitting beside it: an
  // archive names its own project and carries its own schemas, so the name,
  // question and schema pickers would be three decisions the import ignores.
  if (archive) {
    return (
      <Modal title="Import a project" onClose={onClose} testid="new-project-wizard">
        {/* Same shell as the create form, so the dialog does not resize under
            the pointer when a file is chosen. */}
        <div className="form wizard-shell">
          <div className="wizard-body">
          {/* WHAT IS ABOUT TO HAPPEN, before it happens. An import writes a
              whole project into the library; a user is owed the chance to see
              that it is the right file and the right project first. */}
          <div className="import-summary" data-testid="import-summary">
            <div className="import-project">{archive.project_name}</div>
            {archive.project_description && (
              <div className="import-desc">{archive.project_description}</div>
            )}
            <div className="import-facts mono">
              <span>{archive.works} papers</span>
              <span>{archive.analyses} analyses</span>
              <span>{archive.facts} extracted values</span>
              {archive.summaries > 0 && <span>{archive.summaries} summaries</span>}
              {archive.citation_edges > 0 && <span>{archive.citation_edges} citations</span>}
              <span>{fmtBytes(archive.size_bytes)}</span>
            </div>
            {/* Both stated, because their ABSENCE is what a reader needs to
                know: a project without its PDFs cannot show a paper, and one
                without its index searches by keyword until it is rebuilt. */}
            <div className="import-notes">
              {archive.has_pdfs ? (
                <span className="import-note-ok">Includes {archive.pdfs} PDFs.</span>
              ) : (
                <span className="import-note-warn">
                  No PDFs — the papers will arrive without their files.
                </span>
              )}
              {archive.embedding_model ? (
                <span className="import-note-ok">
                  Search index built with {archive.embedding_model}; it is kept only if this
                  computer uses the same model.
                </span>
              ) : (
                <span className="import-note-warn">
                  No search index — it will be rebuilt here.
                </span>
              )}
            </div>
            <div className="import-path mono" title={archive.path}>
              {archive.path}
            </div>
          </div>

          {error && (
            <div className="form-error" role="alert" data-testid="wizard-error">
              {error}
            </div>
          )}
          </div>

          <div className="form-actions wizard-footer">
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="import-choose-other"
              disabled={busy}
              onClick={() => {
                setArchive(null)
                setError(null)
              }}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="import-confirm"
              disabled={busy}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : 'Import project'}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="New project" onClose={onClose} testid="new-project-wizard">
      <div className="form wizard-shell">
        <div className="wizard-body">
        <label className="field wizard-field">
          <span className="wizard-label">Project name</span>
          <span className="wizard-help">
            Just a name for now. The next page asks what the project is about.
          </span>
          <input
            className="input"
            data-testid="wizard-name"
            value={name}
            autoFocus
            placeholder="What you want to call this project."
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && name.trim()) {
                e.preventDefault()
                void submit()
              }
            }}
          />
        </label>

        {error && (
          <div className="form-error" role="alert" data-testid="wizard-error">
            {error}
          </div>
        )}
        {/* The OTHER way to get a project: one that already exists. Offered
            here rather than on a separate screen because "I have a project
            already" is an answer to the same question this modal asks, and a
            user restoring a backup or opening a colleague's work should not
            have to fill in a name first to discover the import exists.

            Secondary, and below the divider: creating is the common case. */}
        <div className="wizard-import">
          <span className="wizard-import-text">
            <span className="wizard-import-title">Already have a project archive?</span>
            Import it with everything it holds — papers, PDFs, analyses and summaries.
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="wizard-import"
            disabled={busy}
            onClick={() => void pickArchive()}
          >
            Import project
          </button>
        </div>
        </div>

        <div className="form-actions wizard-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="wizard-submit"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
            data-tip={name.trim() ? undefined : 'Give the project a name first.'}
          >
            {busy ? 'Creating…' : 'Continue'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
