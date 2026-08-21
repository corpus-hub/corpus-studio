import { useEffect, useState } from 'react'
import type { PluginRepositoryDTO } from '@shared/contract'
import { REPOSITORY_CONSENT_SENTENCE } from '@shared/contract/plugins'
import { Modal } from '../ui'

/**
 * Settings → Plugins: CONNECT A REPOSITORY.
 *
 * ONE repository, and connecting to it takes its whole SET — everything it
 * offers is installed and kept current, with no browsing and no per-plugin
 * prompt. There is nothing to choose between, so there is nothing here to
 * choose with: an address, a key, and a check that says how many plugins it
 * holds.
 *
 * THIS RENDERS A BUTTON AND NOTHING ELSE, beside "Add plugin…" and in the same
 * style. Both buttons answer the same question — where a plugin comes from —
 * and the two ways of answering it are peers, so neither may read as the lesser
 * control. Everything else lives in the modal it opens.
 *
 * There is no card, no bar and no status line out here. Connecting is done ONCE
 * and then never again, so anything permanently on the pane for it is a
 * question already answered, re-asked on every visit to a pane opened for other
 * reasons — and it pushed the plugins themselves below the fold.
 *
 * WHAT IS WRONG STILL HAS TO REACH THE USER (hard rule 0.6). A failure behind a
 * button nobody presses is a failure nobody sees, so the button itself carries
 * the exception: a repository that could not be checked marks the button, and
 * the sentence is in its tooltip and in the modal. A HEALTHY repository marks
 * nothing at all — a badge on every healthy install is one nobody reads by the
 * time it turns red.
 *
 * THE CONSENT IS SHOWN BEFORE THE KEY IS SAVED, and it is
 * `REPOSITORY_CONSENT_SENTENCE` from the contract verbatim rather than prose
 * written here — the sentence is the consent, and one that lives in a component
 * is one a later layout change can shorten. What it says is not inferable from
 * the form: everything is installed, the plugins are not sandboxed, and whoever
 * runs the repository therefore chooses what runs on this computer.
 *
 * THE KEY IS WRITE-ONLY, as every secret in this pane is. It never comes back
 * over IPC; the field shows dots when one is stored and is submitted only when
 * typed into, so opening the modal to correct the address cannot silently clear
 * the credential beside it.
 *
 * DISCONNECT IS A PLAIN BUTTON in the modal, not behind a menu. It is the only
 * way out of the removal lock, and a way out that has to be found is not one.
 *
 * STATE SPACE (HARD RULE 0.5), every one distinct and all of them eased:
 *   button     idle · hover · active · focus · failing(marked + tooltip)
 *   address    idle · hover · focus · invalid
 *   key        idle · hover · focus · stored(dots) · typed
 *   test       idle · hover · active · focus · busy · ok · failed
 *   connect    idle · hover · active · focus · busy · refused(no address/key,
 *              aria-disabled with the reason)
 *   check now  idle · hover · active · focus · busy · refused(not connected)
 *   disconnect idle · hover · active · focus · confirming · busy
 *
 * A control REFUSES with `aria-disabled`, never `disabled` — Chromium dispatches
 * neither `pointerover` nor `focusin` on a disabled form control, so its
 * explanation would be readable by nobody. Same rule as `Plugins` and
 * `McpServer`.
 */
export function PluginRepository({ onChanged }: { onChanged: () => Promise<void> }): JSX.Element {
  const [repo, setRepo] = useState<PluginRepositoryDTO | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let dead = false
    void window.api.getPluginRepository().then((r) => {
      if (!dead) setRepo(r)
    })
    return () => {
      dead = true
    }
  }, [])

  // Nothing at all until the answer is in. A button that appears a moment after
  // the pane, beside one that was already there, moves the control the user is
  // reaching for.
  if (repo === null) return <></>

  // The ONLY thing out here that is not the button: a repository that could not
  // be checked, or that left a plugin out. Both are marked ON the button and
  // said in its tooltip, because a failure behind a button nobody presses is a
  // failure nobody sees. A healthy repository marks nothing.
  const problem = repo.connected ? (repo.sentence ?? repo.skipped[0] ?? null) : null

  return (
    <>
      <button
        type="button"
        className={`btn btn-secondary${problem ? ' plug-repo-failing' : ''}`}
        data-testid="plugin-repository-open"
        data-tip={
          problem ??
          (repo.connected
            ? `${repo.address} · ${
                repo.supplied === 1 ? 'supplies one plugin' : `supplies ${repo.supplied} plugins`
              }${repo.lastCheckedAt ? ` · checked ${whenText(repo.lastCheckedAt)}` : ''}`
            : 'Connect a repository that keeps a set of plugins up to date for you.')
        }
        onClick={() => setOpen(true)}
      >
        Connect repository…
      </button>

      {open && (
        <PluginRepositoryModal
          repo={repo}
          setRepo={setRepo}
          onChanged={onChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * The form itself: address, key, the consent, and what to do about it.
 *
 * It owns the DRAFT state only. `repo` is lifted, because the pane behind this
 * shows the connected line and the failure sentence and must not go stale the
 * moment the modal closes.
 */
function PluginRepositoryModal({
  repo,
  setRepo,
  onChanged,
  onClose
}: {
  repo: PluginRepositoryDTO
  setRepo: (r: PluginRepositoryDTO) => void
  onChanged: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [address, setAddress] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; sentence: string } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // The DRAFT wins once the user has typed; before that the field shows what is
  // stored. `null` rather than `''` for "untouched", so clearing the box is a
  // deliberate empty address and not indistinguishable from never having typed.
  const addressValue = address !== null ? address : repo.address
  const canConnect = addressValue.trim().length > 0 && (key.trim().length > 0 || repo.hasKey)
  const busy = connecting || disconnecting || syncing

  const runTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    setTest(null)
    try {
      const r = await window.api.testPluginRepository({ address: addressValue, key })
      setTest({ ok: r.ok, sentence: r.sentence })
    } catch {
      // Main is supposed to RESOLVE with `ok: false` and a sentence; a rejection
      // means the channel itself failed, and Electron prefixes a rejected
      // handler with the channel name, which is not a thing to show anybody.
      setTest({ ok: false, sentence: 'That check could not be run.' })
    } finally {
      setTesting(false)
    }
  }

  const connect = async (): Promise<void> => {
    if (connecting || !canConnect) return
    setConnecting(true)
    setConnectError(null)
    setTest(null)
    try {
      setRepo(await window.api.connectPluginRepository({ address: addressValue, key }))
      setKey('')
      setAddress(null)
      // The table behind this modal has just gained rows — the first cycle runs
      // inside `connect` — so it is re-read rather than left showing the set
      // from before the repository was connected.
      await onChanged()
      // CLOSED ON SUCCESS, because the question it asks has been answered and
      // the result the user wants to see is the table underneath. A failure
      // keeps it open, since the sentence explaining it is in here.
      onClose()
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : 'That repository could not be connected.')
    } finally {
      setConnecting(false)
    }
  }

  const sync = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    try {
      await window.api.syncPluginRepository()
      setRepo(await window.api.getPluginRepository())
      await onChanged()
    } catch {
      setRepo(await window.api.getPluginRepository().catch(() => repo))
    } finally {
      setSyncing(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    if (disconnecting) return
    setDisconnecting(true)
    try {
      setRepo(await window.api.disconnectPluginRepository())
      setConfirming(false)
      setTest(null)
      setKey('')
      setAddress(null)
      await onChanged()
      onClose()
    } catch {
      setConnectError('The repository could not be disconnected.')
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <Modal
      title={repo.connected ? 'Plugin repository' : 'Connect a plugin repository'}
      onClose={() => {
        // A close mid-write would leave the user unsure whether it happened.
        if (busy) return
        onClose()
      }}
      testid="plugin-repository-modal"
    >
      <div className={'plug-repo' + (busy ? ' is-busy' : '')}>
        <p className="set-help">
          A repository is a set of plugins someone keeps for you. Connect one and this app installs
          everything it offers and keeps it up to date on its own.
        </p>

        {/* THE EXCEPTION, in full. The button outside only MARKS that something
            is wrong and carries one line in its tooltip; this is where the whole
            of it is readable. A healthy repository shows neither. */}
        {repo.connected && repo.sentence && (
          <p className="plug-repo-bad" role="alert" data-testid="plugin-repository-problem">
            <span className="badge badge-danger">Not checked</span>
            {repo.sentence}
          </p>
        )}

        {/* Plugins the repository offers and this app did not install. A
            repository reporting itself applied while a promised plugin is
            absent is the one state this feature may not be able to reach. */}
        {repo.skipped.map((s) => (
          <p key={s} className="plug-warning" data-testid="plugin-repository-skipped">
            <span className="badge badge-warn">Left out</span>
            {s}
          </p>
        ))}

        <div className="set-fields plug-repo-fields">
          <label className="set-field plug-field">
            <span className="set-label">Address</span>
            <input
              className="input"
              type="text"
              data-testid="plugin-repository-address"
              placeholder="https://plugins.example.org"
              value={addressValue}
              onChange={(e) => {
                setAddress(e.target.value)
                setTest(null)
              }}
            />
            <span className="plug-help">
              Where the repository is. It must be an https address: what comes back is run on this
              computer.
            </span>
          </label>

          <label className="set-field plug-field">
            <span className="set-label">Key</span>
            <input
              className="input"
              type="password"
              data-testid="plugin-repository-key"
              placeholder={repo.hasKey ? '••••••••' : 'The key you were given'}
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                setTest(null)
              }}
            />
            <span className="plug-help">
              {repo.hasKey
                ? 'A key is stored. Leave this empty to keep it, or type a new one to replace it.'
                : 'Whoever runs the repository gives you this. It is kept on this computer only.'}
            </span>
          </label>

          {/* THE CONSENT, immediately above the button that acts on it and
              BEFORE the key is saved. Verbatim from the contract. */}
          <p className="plug-repo-consent" data-testid="plugin-repository-consent">
            {REPOSITORY_CONSENT_SENTENCE}
          </p>

          <div className="set-actions">
            <button
              type="button"
              className={`btn btn-primary${connecting ? ' plug-busy' : ''}`}
              data-testid="plugin-repository-connect"
              aria-disabled={connecting || !canConnect}
              data-tip={
                connecting
                  ? 'Connecting…'
                  : !addressValue.trim()
                    ? 'Type the repository’s address first.'
                    : !canConnect
                      ? 'Type the key you were given first.'
                      : undefined
              }
              onClick={() => {
                if (connecting || !canConnect) return
                void connect()
              }}
            >
              <span className="btn-swap">
                <span className="btn-swap-face" aria-hidden={connecting}>
                  {repo.connected ? 'Save and check' : 'Connect'}
                </span>
                <span className="btn-swap-face" aria-hidden={!connecting}>
                  Connecting…
                </span>
              </span>
            </button>
            <button
              type="button"
              className={`btn btn-secondary${testing ? ' plug-busy' : ''}`}
              data-testid="plugin-repository-test"
              aria-disabled={testing || !addressValue.trim()}
              data-tip={
                testing
                  ? 'Contacting the repository…'
                  : !addressValue.trim()
                    ? 'Type the repository’s address first.'
                    : 'Ask the repository how many plugins it holds. Nothing is saved or installed.'
              }
              onClick={() => {
                if (testing || !addressValue.trim()) return
                void runTest()
              }}
            >
              {testing ? 'Checking…' : 'Test connection'}
            </button>
            {repo.connected && (
              <button
                type="button"
                className={`btn btn-secondary${syncing ? ' plug-busy' : ''}`}
                data-testid="plugin-repository-sync"
                aria-disabled={syncing}
                data-tip={
                  syncing ? 'Checking for new plugins…' : 'Check now, rather than at the next check.'
                }
                onClick={() => {
                  if (syncing) return
                  void sync()
                }}
              >
                {syncing ? 'Checking…' : 'Check now'}
              </button>
            )}
          </div>

          {/* The answers, below the row and not in it, so a long sentence
              arriving cannot shove the button the user is reaching for
              sideways. */}
          <div className="set-answers" aria-live="polite">
            {test && (
              <p
                className={`set-note ${test.ok ? 'set-note-ok' : 'plug-note-bad'}`}
                data-testid="plugin-repository-test-result"
              >
                {test.sentence}
              </p>
            )}
            {connectError && (
              <p className="set-note plug-note-bad" data-testid="plugin-repository-error">
                {connectError}
              </p>
            )}
          </div>
        </div>

        {repo.connected && (
          <div className="plug-repo-foot">
            <div className="plug-repo-facts">
              <span className="plug-repo-meta">
                {repo.supplied === 1
                  ? 'Supplies one plugin here'
                  : `Supplies ${repo.supplied} plugins here`}
                {repo.lastCheckedAt && ` · last checked ${whenText(repo.lastCheckedAt)}`}
              </span>
              {/* WHAT DISCONNECTING COSTS AND WHAT IT DOES NOT, said where the
                  button is, because the button is the only way out of the
                  removal lock and the fear it has to answer is "will I lose
                  them". */}
              <span className="plug-repo-why">
                While it is connected, its plugins cannot be removed here — switch one off to stop
                it running. Disconnecting leaves them all installed and gives Remove back.
              </span>
            </div>
            {confirming ? (
              <div className="plug-danger-actions">
                <button
                  type="button"
                  className={`btn btn-danger btn-sm${disconnecting ? ' plug-busy' : ''}`}
                  data-testid="plugin-repository-disconnect-confirm"
                  aria-disabled={disconnecting}
                  data-tip={disconnecting ? 'Disconnecting…' : undefined}
                  onClick={() => {
                    if (disconnecting) return
                    void disconnect()
                  }}
                >
                  {disconnecting ? 'Disconnecting…' : 'Yes, disconnect'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid="plugin-repository-disconnect-cancel"
                  aria-disabled={disconnecting}
                  data-tip={
                    disconnecting ? 'Disconnecting — this can no longer be stopped.' : undefined
                  }
                  onClick={() => {
                    if (disconnecting) return
                    setConfirming(false)
                  }}
                >
                  Stay connected
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="plugin-repository-disconnect"
                onClick={() => setConfirming(true)}
              >
                Disconnect
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * "3 minutes ago", or a date once that stops meaning anything.
 *
 * A CHECK IS NEWS FOR AN HOUR OR SO and then it is a fact; "yesterday at 14:02"
 * is what someone asking "is this still working" can act on, and a relative
 * string measured in days is not.
 */
function whenText(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'recently'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return new Date(t).toLocaleString()
}
