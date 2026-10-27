import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectDTO } from '@shared/types'
import type { SharedProjectDTO } from '@shared/contract'
import { Modal } from './ui'
import { SharedGlyph, shortfallSentence } from './SyncStatusIcon'

/**
 * The one place the words "share", "join" and "invitation" appear.
 *
 * ALL THREE ACTIONS IN ONE MODAL, deliberately. Sharing, joining and stopping
 * are the same decision seen from three sides, and a user who has just been sent
 * an invitation is looking for whichever of them applies to them — splitting
 * them across a project card, a settings pane and a context menu would mean
 * finding the right one first. It is also why the entry point renders only when
 * the plugin is ON: on every other install this vocabulary is noise.
 *
 * THE ROOM ID IS NEVER SHOWN AGAIN. `shareProject` returns the invitation once
 * and no DTO ever carries it, because it is the read capability for the whole
 * project. A user who loses it re-keys the room rather than asking for it back,
 * so the copy affordance is on screen while the invitation is, and the clipboard
 * is cleared afterwards.
 *
 * STATE SPACE (HARD RULE 0.5), enumerated before it was written and all distinct:
 *   mode switch    idle · hover · active · focus-visible · selected ·
 *                  selected+hover
 *   invite field   idle · hover · focus · invalid(with its reason)
 *   name field     idle · hover · focus
 *   submit         idle · hover · active · focus · refusing(aria-disabled with
 *                  the reason) · busy
 *   share row      origin · replica, each × in-step · out-of-step · failed ·
 *                  needs-credentials · incomplete (rows this version can never
 *                  store), incomplete composing with all of them, and its Stop
 *                  button × hover/active/busy
 *   invitation     revealed · copied (a 2s acknowledgement, then back)
 * Everything eases at 150ms; nothing snaps.
 */

type Mode = 'join' | 'share'

/**
 * Every sentence a sharing verb may reject with, mirroring the closed sets in
 * `src/main/index.ts`.
 *
 * SECOND OF TWO LOCKS ON THE SAME DOOR, exactly as `SyncStatusIcon` is for
 * `syncNow`. Main maps everything else to the fallback already; this is the one
 * that holds if a future edit up there forgets, and it is a lock worth having
 * because what gets through is rendered VERBATIM into `.form-error`: undici's
 * messages carry the relay URL, zod's carry the field's byte cap, and Electron
 * wraps a rejected handler as `Error invoking remote method '<channel>': …`.
 *
 * Matched by IDENTITY, never by shape. A "does this read like prose" test
 * admits any well-punctuated line, including one carrying an address.
 */
const HOST_SENTENCES = [
  'Turn the plugin that shares projects on in Settings → Plugins first.',
  'That feature comes from a plugin that is not installed.',
  'That feature comes from a plugin that does not offer it. It may be an older version.',
  'That plugin is not installed.'
]

const SHARE_FALLBACK = 'That project could not be shared. Check the plugin that shares projects in Settings → Plugins.'
const JOIN_FALLBACK =
  'That project could not be joined. Check the invitation, and the plugin that shares projects in Settings → Plugins.'
const STOP_FALLBACK = 'That project could not be stopped. Check the plugin that shares projects in Settings → Plugins.'

const SHARE_SENTENCES = new Set([
  ...HOST_SENTENCES,
  'That project is already shared.',
  'That project could not be read.',
  SHARE_FALLBACK
])

const JOIN_SENTENCES = new Set([
  ...HOST_SENTENCES,
  'That invitation is not one this app recognises.',
  'Give this project a name on this computer.',
  'That project is already on this computer.',
  JOIN_FALLBACK
])

const STOP_SENTENCES = new Set([...HOST_SENTENCES, STOP_FALLBACK])

function sentenceOf(err: unknown, allowed: ReadonlySet<string>, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const stripped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
  return allowed.has(stripped) ? stripped : fallback
}

export function SharingModal({
  projects,
  shares,
  onClose,
  onChanged
}: {
  projects: readonly ProjectDTO[]
  shares: readonly SharedProjectDTO[]
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  // JOIN LEADS. A user opening this because someone sent them something has an
  // invitation in hand; a user sharing their own work came looking on purpose
  // and will find the second tab.
  const [mode, setMode] = useState<Mode>('join')
  const shared = new Set(shares.map((s) => s.projectId))
  const unshared = projects.filter((p) => !shared.has(p.id))

  return (
    <Modal title="Shared projects" onClose={onClose} testid="sharing-modal">
      <div className="form share-form">
        <div className="share-modes" role="tablist" aria-label="Sharing">
          <ModeButton mode="join" current={mode} onPick={setMode} label="Join someone's project" />
          <ModeButton mode="share" current={mode} onPick={setMode} label="Share one of mine" />
        </div>

        {mode === 'join' ? (
          <JoinPane onJoined={onChanged} onClose={onClose} />
        ) : (
          <SharePane projects={unshared} total={projects.length} onShared={onChanged} />
        )}

        <ShareList shares={shares} projects={projects} onChanged={onChanged} />
      </div>
    </Modal>
  )
}

function ModeButton({
  mode,
  current,
  onPick,
  label
}: {
  mode: Mode
  current: Mode
  onPick: (m: Mode) => void
  label: string
}): JSX.Element {
  const on = current === mode
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      aria-controls={`share-pane-${mode}`}
      id={`share-tab-${mode}`}
      className={`share-mode${on ? ' is-on' : ''}`}
      data-testid={`share-mode-${mode}`}
      onClick={() => onPick(mode)}
    >
      {label}
    </button>
  )
}

/**
 * Joining. The invitation and a local name, and nothing else.
 *
 * The name is asked for because `project.name` is scoped out of last-write-wins
 * — one user renaming their copy must not rename everyone's — so a replica has
 * no name to inherit and inventing one ("Shared project 2") would leave the user
 * with a library of identical rows.
 */
function JoinPane({ onJoined, onClose }: { onJoined: () => void; onClose: () => void }): JSX.Element {
  const [invite, setInvite] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = invite.trim().length > 0 && name.trim().length > 0
  const why = !invite.trim()
    ? 'Paste the invitation your colleague sent you.'
    : !name.trim()
      ? 'Give the project a name for this computer.'
      : undefined

  const submit = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.api.joinProject({ invite: invite.trim(), name: name.trim() })
      onJoined()
      onClose()
    } catch (e) {
      setError(sentenceOf(e, JOIN_SENTENCES, JOIN_FALLBACK))
      setBusy(false)
    }
  }

  return (
    <div className="share-pane" role="tabpanel" id="share-pane-join" aria-labelledby="share-tab-join" data-testid="share-join-pane">
      <p className="share-lede">
        An invitation is a single line of text your colleague copied when they shared their project.
        It grants whoever holds it read access to everything in that project, so it is worth treating
        like a password.
      </p>
      <label className="field">
        <span className="field-label">Invitation</span>
        <input
          className="input mono"
          data-testid="share-invite"
          value={invite}
          autoFocus
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          placeholder="paste it here"
          onChange={(e) => {
            setError(null)
            setInvite(e.target.value)
          }}
        />
      </label>
      <label className="field">
        <span className="field-label">Name it on this computer</span>
        <input
          className="input"
          data-testid="share-join-name"
          value={name}
          placeholder="e.g. Anna's enzyme review"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="plug-help">
          Only you see this name. Renaming a shared project never renames anyone else&rsquo;s copy.
        </span>
      </label>

      <p className="share-note">
        The project appears straight away, empty and marked <em>Not in sync</em>, and fills itself in
        over the next few minutes. Your colleague&rsquo;s PDFs are not sent — only what has been read
        out of them.
      </p>

      {error && (
        <div className="form-error" role="alert" data-testid="share-join-error">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button
          type="button"
          className={`btn btn-primary${busy ? ' plug-busy' : ''}`}
          data-testid="share-join-submit"
          // `aria-disabled`, never `disabled`: Chromium dispatches no pointer or
          // focus event on a disabled control, so its explanation would be
          // readable by nobody.
          aria-disabled={!ready || busy}
          data-tip={busy ? 'Joining…' : why}
          onClick={() => void submit()}
        >
          {busy ? 'Joining…' : 'Join project'}
        </button>
      </div>
    </div>
  )
}

/** Sharing one of this install's own projects, and revealing its invitation once. */
function SharePane({
  projects,
  total,
  onShared
}: {
  /** The ones that can still be shared. */
  projects: readonly ProjectDTO[]
  /** How many exist at all — "none yet" and "all shared" are different answers. */
  total: number
  onShared: () => void
}): JSX.Element {
  const [picked, setPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invite, setInvite] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (picked === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.shareProject(picked)
      setInvite(res.invite)
      onShared()
    } catch (e) {
      setError(sentenceOf(e, SHARE_SENTENCES, SHARE_FALLBACK))
    } finally {
      setBusy(false)
    }
  }

  if (invite !== null) return <InviteReveal invite={invite} />

  if (projects.length === 0) {
    return (
      <div className="share-pane" role="tabpanel" id="share-pane-share" aria-labelledby="share-tab-share" data-testid="share-share-pane">
        <p className="share-lede">
          {total === 0
            ? 'There are no projects on this computer yet. Create one and add some papers, then come back to share it.'
            : 'Every project on this computer is already shared.'}
        </p>
      </div>
    )
  }

  return (
    <div className="share-pane" role="tabpanel" id="share-pane-share" aria-labelledby="share-tab-share" data-testid="share-share-pane">
      <p className="share-lede">
        Sharing publishes this project&rsquo;s notes, bibliographic records, rankings and extracted
        values to your relay, where anyone holding the invitation can read them. It cannot be taken
        back off their computers afterwards. Your PDFs stay here.
      </p>
      <div className="field">
        <span className="field-label">Project</span>
        <div className="share-picks" data-testid="share-picks">
          {projects.map((p) => {
            const on = picked === p.id
            return (
              <button
                key={p.id}
                type="button"
                className={`share-pick${on ? ' is-on' : ''}`}
                aria-pressed={on}
                data-testid={`share-pick-${p.id}`}
                onClick={() => setPicked(on ? null : p.id)}
              >
                <span className="share-pick-check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span className="share-pick-name">{p.name}</span>
                <span className="share-pick-size mono">
                  {p.work_count} {p.work_count === 1 ? 'paper' : 'papers'}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {error && (
        <div className="form-error" role="alert" data-testid="share-error">
          {error}
        </div>
      )}

      <div className="form-actions">
        <button
          type="button"
          className={`btn btn-primary${busy ? ' plug-busy' : ''}`}
          data-testid="share-submit"
          aria-disabled={picked === null || busy}
          data-tip={busy ? 'Publishing…' : picked === null ? 'Choose a project to share.' : undefined}
          onClick={() => void submit()}
        >
          {busy ? 'Publishing…' : 'Share project'}
        </button>
      </div>
    </div>
  )
}

/**
 * The invitation, shown ONCE.
 *
 * No DTO carries it and nothing stores it for the UI, so navigating away from
 * this panel loses it for good — which the panel says, rather than letting the
 * user find out. The clipboard is cleared after two minutes so an invitation does
 * not sit in the paste buffer for the rest of the day.
 */
function InviteReveal({ invite }: { invite: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t)
    },
    []
  )

  const copy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(invite)
    } catch {
      // A refused clipboard is silent otherwise, and the button would simply not
      // change — indistinguishable from a copy that worked and from a dead
      // control. The invitation is on screen and can be selected by hand, which
      // is what the message says.
      setFailed(true)
      return
    }
    setFailed(false)
    setCopied(true)
    timers.current.push(setTimeout(() => setCopied(false), 2000))
    timers.current.push(
      setTimeout(() => {
        // Best-effort: another app may own the clipboard by now, and failing to
        // clear it is not something to interrupt the user about.
        void navigator.clipboard.writeText('').catch(() => {})
      }, 120_000)
    )
  }, [invite])

  return (
    <div className="share-pane share-invite" role="tabpanel" id="share-pane-share" aria-labelledby="share-tab-share" data-testid="share-invite-reveal">
      <p className="share-lede">
        Send this to the people you want to share with, over something private. It is shown once and
        this app does not keep a copy — if you lose it you can share the project again, which gives
        everyone a new invitation.
      </p>
      <div className="share-invite-box mono" data-testid="share-invite-value">
        {invite}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className={`btn btn-primary${copied ? ' is-copied' : ''}`}
          data-testid="share-invite-copy"
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy invitation'}
        </button>
        {failed && (
          <span className="set-note plug-note-bad" data-testid="share-invite-copy-failed">
            This computer would not let the app use the clipboard. Select the text above and copy it
            yourself.
          </span>
        )}
      </div>
    </div>
  )
}

/** What is already shared, and the one action that applies to it. */
function ShareList({
  shares,
  projects,
  onChanged
}: {
  shares: readonly SharedProjectDTO[]
  projects: readonly ProjectDTO[]
  onChanged: () => void
}): JSX.Element | null {
  const [stopping, setStopping] = useState<number | null>(null)
  // Keyed by project, because the failure belongs to the ROW that failed and not
  // to the list: a single message under the heading would move around as the
  // user tried the next one, and would outlive the row it described.
  const [stopError, setStopError] = useState<Record<number, string>>({})
  if (shares.length === 0) return null
  const nameOf = (id: number): string => projects.find((p) => p.id === id)?.name ?? 'Project'

  const stop = async (projectId: number): Promise<void> => {
    if (stopping !== null) return
    setStopping(projectId)
    setStopError((prev) => {
      const { [projectId]: _gone, ...rest } = prev
      return rest
    })
    try {
      await window.api.unshareProject(projectId)
      onChanged()
    } catch (e) {
      // A stop that fails leaves the row exactly where it was, so the row must
      // SAY so: without this the only feedback is that pressing again does the
      // same thing, and the user presses forever. Every other action here has a
      // failure state.
      setStopError((prev) => ({ ...prev, [projectId]: sentenceOf(e, STOP_SENTENCES, STOP_FALLBACK) }))
    } finally {
      setStopping(null)
    }
  }

  return (
    <div className="share-list" data-testid="share-list">
      <span className="field-label">Already shared</span>
      {shares.map((s) => {
        const failed = s.state === 'failed' || s.state === 'needs-credentials'
        const short = s.declinedRows > 0
        // A SHORTFALL IS NOT AN OUT-OF-STEP, but a share can be BOTH. The count
        // is a standing ledger over the whole corpus, so suppressing "Not in
        // sync" whenever it is non-zero would hide a real, resync-fixable
        // divergence for good — the plugin's own `resync` and `syncing` states
        // say the peer is genuinely behind. Only the RESTING incomplete state
        // ('idle', which is where a peer caught up as far as it can go comes to
        // rest) means the gap is the shortfall and nothing else.
        const restingShort = short && s.state === 'idle'
        const outOfSync = !s.inSync && !failed && !restingShort && s.state !== 'syncing'
        const stopFailed = stopError[s.projectId]
        return (
          <div
            key={s.projectId}
            className={
              'share-row' +
              (outOfSync ? ' is-out-of-sync' : '') +
              (short ? ' is-incomplete' : '') +
              (failed ? ' is-failed' : '') +
              (s.state === 'syncing' ? ' is-syncing' : '') +
              (stopFailed ? ' is-stop-failed' : '')
            }
            data-testid={`share-row-${s.projectId}`}
          >
            <SharedGlyph />
            <span className="share-row-name">{nameOf(s.projectId)}</span>
            {/* The ROLE reads as prose in the row's own voice, NOT as a pill.
                It is true of every row, so styling it like the warn and danger
                chips beside it would put a chip on every line and take those two
                down with it — hard rule 0.6. */}
            <span className="share-row-role">
              {s.role === 'origin' ? 'shared by you' : 'joined from an invitation'}
            </span>
            {outOfSync && <span className="badge badge-warn">Not in sync</span>}
            {failed && (
              <span className="badge badge-danger" data-tip={s.sentence ?? undefined}>
                {s.state === 'needs-credentials' ? 'Sign in again' : 'Sync failed'}
              </span>
            )}
            {/* BOTH, where the navbar shows one. This row has the width for a
                second chip, and "failing now" and "short for good" are separate
                things to do something about.

                FOCUSABLE, and carrying the sentence in text as well as in the
                tooltip. "3 rows not stored" on its own reads as something a
                retry fixes, and a `data-tip` on an unfocusable span is
                mouse-only — so a keyboard reader would have got the half of the
                message that is misleading and none of the half that corrects
                it. */}
            {short && (
              <span
                className="badge badge-warn"
                tabIndex={0}
                data-tip={shortfallSentence(s.declinedRows) ?? undefined}
                data-testid={`share-declined-${s.projectId}`}
              >
                <span aria-hidden="true">
                  {s.declinedRows} {s.declinedRows === 1 ? 'row' : 'rows'} not stored
                </span>
                <span className="share-row-sr">{shortfallSentence(s.declinedRows)}</span>
              </span>
            )}
            <button
              type="button"
              // FAILED IS ON THE BUTTON, not only on the row. The control the
              // user pressed is the one they are looking at when it does not
              // work, and a button that returns to its resting look after a
              // refusal invites the same press again — which is the loop this
              // whole finding was about.
              className={
                'btn btn-secondary share-stop' +
                (stopping === s.projectId ? ' plug-busy' : '') +
                (stopFailed && stopping === null ? ' is-failed' : '')
              }
              data-testid={`share-stop-${s.projectId}`}
              aria-disabled={stopping !== null}
              data-tip={
                stopping === s.projectId
                  ? 'Stopping…'
                  : stopping !== null
                    ? 'Another project is being stopped. This will be available in a moment.'
                    : stopFailed
                      ? 'Try stopping this again.'
                      : 'Stop syncing this project. Everything already on this computer stays; the copies your colleagues have are untouched.'
              }
              onClick={() => void stop(s.projectId)}
            >
              {stopping === s.projectId ? 'Stopping…' : stopFailed ? 'Try again' : 'Stop sharing'}
            </button>
            {stopFailed && (
              <span className="share-row-error" role="alert" data-testid={`share-stop-error-${s.projectId}`}>
                {stopFailed}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
