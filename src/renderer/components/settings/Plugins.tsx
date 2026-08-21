import { useCallback, useEffect, useState } from 'react'
import type {
  PluginDTO,
  PluginListDTO,
  PluginParamDTO,
  PluginRemovedDTO,
  PluginRunState
} from '@shared/contract'
import { PluginRepository } from './PluginRepository'

/**
 * Why a repository plugin's Remove refuses, on the control that refuses.
 *
 * ONE literal, used by both places Remove appears (the row and the detail
 * footer), because two copies of a tooltip drift and the drift is silent. It
 * says what to do instead, which is the whole point: the lock has exactly one
 * release, and a refusal that does not name it leaves the user looking for a
 * button that is not there.
 */
const REPOSITORY_LOCK_TIP =
  'Supplied by the connected repository — disconnect it in order to remove this. '
  + 'Switching it off stops it running.'

/**
 * Settings → Plugins: a TABLE of what is installed, and a configuration form
 * behind each row.
 *
 * GENERIC. Nothing here knows what any plugin does. The table renders whatever
 * `listPlugins()` returns, and the form renders one field per DECLARED
 * parameter, switching on `kind`. A second plugin costs no change in this file.
 * That is not tidiness: a pane that special-cased one plugin would be a pane
 * where the next plugin's controls are outside every audit ever run over this
 * one — and, since a plugin can now be a folder a stranger wrote, "the UI can
 * only render controls this file already had" is a security property.
 *
 * SECRETS ARE WRITE-ONLY. A `secret` param has no value in the DTO; the field
 * shows dots when `secretsSet[key]` and is SUBMITTED only when typed into. An
 * empty box means "unchanged", not "clear" — otherwise opening Settings to fix
 * a typo in an address would silently delete the password beside it.
 *
 * STATE SPACE (HARD RULE 0.5), enumerated before it was written, every one
 * distinct from every other and all of them eased.
 * `scripts/check-plugin-states.mjs` resolves each combination against the BUILT
 * css in a real browser and asserts no two render identically.
 *   row      idle · hover · focus-within · enabled · enabled+hover · broken ·
 *            broken+hover · bundled · busy
 *   add btn  idle · hover · active · focus · busy
 *   remove   idle · hover · active · focus · refused(bundled, aria-disabled
 *            with the reason) · confirming · busy
 *   toggle   off · off+hover · off+focus · off+active · on · on+hover ·
 *            on+focus · on+active · busy · blocked
 *   status   working · not configured · failing — THREE, and never a fourth
 *   field    idle · hover · focus · rejected · dirty · saving · saved
 *   test     idle · hover · active · focus · busy · ok · failed
 *
 * A CONTROL REFUSES WITH `aria-disabled`, NEVER `disabled` — Chromium dispatches
 * neither `pointerover` nor `focusin` on a disabled form control, and the
 * tooltip is delegated off exactly those, so a disabled control's explanation
 * would be readable by nobody. This is the rule `McpServer` already documents.
 *
 * NOTHING SIGNALS BY COLOUR ALONE: every state carries a WORD as well as a hue,
 * and the toggle's knob carries a glyph and slides.
 */

/**
 * THREE WORDS, AND THERE MAY NEVER BE A FOURTH.
 *
 * The reader of this column is asking one question — can I rely on this plugin
 * right now — and it has exactly three answers: yes, not yet, no. Everything
 * else the plugin knows about itself is DETAIL, and detail belongs in the
 * sentence beneath, not in a word that changes what the column means.
 *
 * There were seven: Off, Ready, Syncing, Working, Catching up, Failed and Sign
 * in again. Two of them (Syncing, Catching up) are the same fact as Working
 * seen a second later, and they made a healthy plugin flicker between three
 * different words while nothing was wrong. Two more (Off, Ready) were both
 * "not running", already stated by the toggle beside them. The column became
 * something to decode rather than read, which is worse than no column.
 *
 * The mapping is TOTAL over `PluginRunState`, so a state added to the contract
 * cannot quietly introduce a fourth word: it must be assigned to one of these
 * three — or to `null`, which is silence and not a fourth word.
 *
 * `off` is the one state that gets the silence. The host writes it for exactly
 * one reason: the plugin is switched off, which the toggle in the very next
 * cell already says, in a control the user can act on. Repeating it as "Not
 * configured" states something the app does not know — a fully configured
 * plugin somebody switched off for the afternoon is not unconfigured — and a
 * word on every resting row is a word nobody reads by the time it matters
 * (hard rule 0.6).
 */
const STATE_WORD: Record<PluginRunState, string | null> = {
  // Running and doing its job. A cycle in flight is not a different answer,
  // and neither is resting between cycles: `idle` is what an enabled plugin
  // with nothing to do right now reports — no shares yet, nothing new to
  // fetch — which is a working plugin, not a missing setting.
  ok: 'Working',
  syncing: 'Working',
  resync: 'Working',
  idle: 'Working',
  // Running and unable to do its job for want of something only the user can
  // give it: a sign-in the relay rejected, a companion that is not installed.
  'needs-credentials': 'Not configured',
  // Running and unable to do its job. The only state that is a problem.
  failed: 'Failing',
  // Switched off. The toggle beside it is the sentence.
  off: null
}

/**
 * The style key for each state — three, matching the three words exactly.
 *
 * Separate from the word only because CSS needs a slug. It is deliberately NOT
 * `plug-state-${state}`: that produced a class per run state, so the seven words
 * were seven colours, and a plugin mid-cycle changed hue while nothing was
 * happening to it.
 */
const STATE_KIND: Record<PluginRunState, 'working' | 'unconfigured' | 'failing' | null> = {
  ok: 'working',
  syncing: 'working',
  resync: 'working',
  idle: 'working',
  'needs-credentials': 'unconfigured',
  failed: 'failing',
  off: null
}

export function Plugins(): JSX.Element {
  const [list, setList] = useState<PluginListDTO | null>(null)
  /** The id whose configuration form is open, or null for the table. */
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  /** The refusal from the last Add, shown until the next attempt. */
  const [addError, setAddError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setList(await window.api.listPlugins())
  }, [])

  useEffect(() => {
    let dead = false
    void window.api.listPlugins().then((p) => {
      if (!dead) setList(p)
    })
    // The sync state moves on a ten-second timer in MAIN, so the pane subscribes
    // rather than polling: a poll here would either lag the state it is showing
    // or add a second timer racing the first.
    const off = window.api.onSharesChanged(() => {
      void window.api.listPlugins().then((p) => {
        if (!dead) setList(p)
      })
    })
    return () => {
      dead = true
      off()
    }
  }, [])

  const add = async (): Promise<void> => {
    if (adding) return
    setAdding(true)
    setAddError(null)
    setAdded(null)
    try {
      const res = await window.api.addPluginFromFolder()
      // CANCELLING SAYS NOTHING. Changing your mind in a file chooser is not a
      // failure, and an error banner every time somebody backs out is one they
      // learn to dismiss without reading — taking the real refusal with it.
      if (res.cancelled) return
      if (res.reason) {
        setAddError(res.reason)
        return
      }
      if (res.plugin) setAdded(res.plugin.name)
      await reload()
    } catch {
      setAddError('That folder could not be installed as a plugin.')
    } finally {
      setAdding(false)
    }
  }

  if (list === null) {
    return <div className="settings-storage-hint mono">Reading…</div>
  }
  const plugins = list.plugins

  const open = openId ? (plugins.find((p) => p.id === openId) ?? null) : null
  if (open) {
    return (
      <PluginConfig
        plugin={open}
        onBack={() => setOpenId(null)}
        onChanged={reload}
        onRemoved={async () => {
          setOpenId(null)
          await reload()
        }}
      />
    )
  }

  return (
    <div className="plug-pane" data-testid="settings-plugins">
      <div className="plug-toolbar">
        <div className="plug-toolbar-text">
          <h3 className="set-h3">Installed plugins</h3>
          <p className="set-help">
            A plugin is a folder. Drop one into this app’s plugins folder, or add it below. A
            plugin you add runs with the same access to your library as the app itself — install
            only ones you trust, as you would any program.
          </p>
        </div>
        <div className="plug-toolbar-actions">
          {/* BESIDE Add plugin and in the same style. Both answer the same
              question — where a plugin comes from — so one of them reading as
              a lesser control would be a claim about that which is not true. */}
          <PluginRepository onChanged={reload} />
          <button
            type="button"
            className={`btn btn-primary${adding ? ' plug-busy' : ''}`}
            data-testid="plugin-add"
            aria-disabled={adding}
            data-tip={adding ? 'Waiting for you to choose a folder…' : undefined}
            onClick={() => {
              if (adding) return
              void add()
            }}
          >
            {adding ? 'Choosing…' : 'Add plugin…'}
          </button>
        </div>
      </div>

      {addError && (
        <p className="plug-add-error" role="alert" data-testid="plugin-add-error">
          <span className="badge badge-danger">Not added</span>
          {addError}
        </p>
      )}
      {added && !addError && (
        <p className="set-note set-note-ok" data-testid="plugin-add-ok">
          {added} was added. Configure it, then turn it on.
        </p>
      )}

      {plugins.length === 0 ? (
        <p className="plug-empty" data-testid="plugin-empty">
          No plugins are installed. Add one with the button above.
        </p>
      ) : (
        <div className="plug-table" role="table" aria-label="Installed plugins">
          <div className="plug-thead" role="row">
            {/* The SAME cell classes as the row below, so a heading is laid out
                by the same rules as the content it names. */}
            <span role="columnheader" className="plug-cell plug-cell-name">
              Plugin
            </span>
            <span role="columnheader" className="plug-cell plug-cell-status">
              Status
            </span>
            <span role="columnheader" className="plug-cell plug-cell-toggle">
              On
            </span>
            <span role="columnheader" className="plug-cell plug-cell-actions">
              Actions
            </span>
          </div>
          {plugins.map((p) => (
            <PluginRow
              key={p.id}
              plugin={p}
              onConfigure={() => setOpenId(p.id)}
              onChanged={reload}
            />
          ))}
        </div>
      )}

      {/* NOTHING AT ALL in the ordinary case, which is why this is not a tab or
          an always-present heading: a user who has removed nothing must not read
          a section telling them so. It appears because a decision they made is
          still in force and is otherwise invisible — a plugin the app refuses to
          load, which no reinstall and no update would undo. */}
      {list.removed.length > 0 && (
        <div className="plug-removed" data-testid="plugins-removed">
          <h4 className="plug-removed-h">Removed</h4>
          <p className="set-help">
            These came with the app and you took them out. They are not loaded, and an update
            that ships them again will not bring them back.
          </p>
          {list.removed.map((r) => (
            <RemovedRow key={r.id} removed={r} onChanged={reload} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One removed plugin: its id, and the one thing left to do about it.
 *
 * ITS ID IS ALL IT HAS. Its manifest is deliberately never read — the whole
 * point of a removal is that the folder is not opened — so there is no name and
 * no blurb, and inventing one from the id would be the app pretending to know
 * something it refused to look up.
 */
function RemovedRow({
  removed,
  onChanged
}: {
  removed: PluginRemovedDTO
  onChanged: () => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const restore = async (): Promise<void> => {
    if (busy || !removed.present) return
    setBusy(true)
    setError(null)
    try {
      await window.api.restorePlugin(removed.id)
      await onChanged()
    } catch {
      setError('That plugin could not be put back.')
    } finally {
      // ALWAYS cleared, including on success. A restore whose folder then fails
      // to load leaves this row on screen, and clearing the flag only in the
      // catch left it reading "Putting back…" for the rest of the session with
      // nothing to press.
      setBusy(false)
    }
  }

  return (
    <div
      className={`plug-removed-row${busy ? ' is-busy' : ''}`}
      data-testid={`plugin-removed-${removed.id}`}
    >
      <span className="plug-removed-id mono">{removed.id}</span>
      {error && (
        <span className="plug-row-error" role="alert">
          {error}
        </span>
      )}
      <button
        type="button"
        className={`btn btn-secondary btn-sm${busy ? ' plug-busy' : ''}`}
        data-testid={`plugin-restore-${removed.id}`}
        aria-disabled={busy || !removed.present}
        // Absent is a REAL state and gets the tooltip rather than the row being
        // dropped: the record still stops this id loading if the folder ever
        // comes back, so hiding it would be a rule with no way to see or change
        // it (hard rule 0.5).
        data-tip={
          !removed.present
            ? 'This plugin is no longer in the app, so there is nothing to put back. It will stay out if a later update ships it again.'
            : busy
              ? 'Putting it back…'
              : undefined
        }
        onClick={() => void restore()}
      >
        {busy ? 'Putting back…' : 'Put back'}
      </button>
    </div>
  )
}

function PluginRow({
  plugin,
  onConfigure,
  onChanged
}: {
  plugin: PluginDTO
  onConfigure: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [toggling, setToggling] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rowError, setRowError] = useState<string | null>(null)

  const failed = plugin.failedToLoad !== null
  const blocked = plugin.blockers.length > 0
  const state = plugin.status.state

  const toggle = async (): Promise<void> => {
    if (blocked || toggling || failed) return
    setToggling(true)
    setRowError(null)
    try {
      await window.api.setPluginEnabled(plugin.id, !plugin.enabled)
      await onChanged()
    } catch {
      setRowError('That plugin could not be turned on.')
    } finally {
      setToggling(false)
    }
  }

  const update = async (): Promise<void> => {
    if (updating) return
    setUpdating(true)
    setRowError(null)
    try {
      const res = await window.api.updatePluginFromFolder(plugin.id)
      // CANCELLED IS NOT A FAILURE and says nothing. The user closed a chooser
      // they opened; an error where they expected silence reads as though the
      // app tried something.
      if (!res.cancelled && res.reason) setRowError(res.reason)
      if (!res.cancelled) await onChanged()
    } catch {
      setRowError('That plugin could not be updated.')
    } finally {
      setUpdating(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (removing) return
    setRemoving(true)
    setRowError(null)
    try {
      await window.api.removePlugin(plugin.id)
      await onChanged()
    } catch {
      setRowError('That plugin could not be removed.')
      setRemoving(false)
      setConfirming(false)
    }
  }

  return (
    <div
      className={
        'plug-row' +
        (plugin.enabled ? ' is-on' : '') +
        (failed ? ' is-failed' : '') +
        (toggling || removing || updating ? ' is-busy' : '')
      }
      role="row"
      data-testid={`plugin-${plugin.id}`}
    >
      <div className="plug-cell plug-cell-name" role="cell">
        <span className="plug-name">{plugin.name}</span>
        <span className="plug-blurb">{failed ? plugin.failedToLoad : plugin.blurb}</span>
        {rowError && <span className="plug-row-error">{rowError}</span>}
      </div>

      {/* At most ONE of three words, whatever the row is. A folder that would
          not load is Failing for the same reason a running plugin that cannot
          reach its server is: the reader asked whether they can rely on it, and
          the answer is no. Which of the two it is belongs in the sentence under
          the word, not in a fourth word.

          `blockers` are only computed for a plugin that is NOT enabled
          (`toDto` in host.ts), so this shortcut can never speak over a running
          one — for a switched-off plugin that is also missing a setting, "Not
          configured" is the thing the toggle does not already say. */}
      <div className="plug-cell plug-cell-status" role="cell">
        {(failed || blocked || STATE_WORD[state] !== null) && (
          <span
            className={`plug-state plug-state-${failed ? 'failing' : blocked ? 'unconfigured' : STATE_KIND[state]}`}
            data-testid={`plugin-state-${plugin.id}`}
          >
            <span className="plug-state-word">
              {failed ? 'Failing' : blocked ? 'Not configured' : STATE_WORD[state]}
            </span>
            {!failed && !blocked && plugin.status.sentence && (
              <span className="plug-state-why">{plugin.status.sentence}</span>
            )}
          </span>
        )}
      </div>

      <div className="plug-cell plug-cell-toggle" role="cell">
        <button
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-disabled={blocked || toggling || failed}
          // The reason it refuses, on the control that refuses. A disabled
          // control that does not explain itself is the failure hard rule 0.5
          // names by name.
          data-tip={
            failed
              ? (plugin.failedToLoad ?? undefined)
              : blocked
                ? plugin.blockers[0]
                : undefined
          }
          data-testid={`plugin-toggle-${plugin.id}`}
          className={
            'settings-switch plug-switch' +
            (plugin.enabled ? ' is-on' : '') +
            (toggling ? ' is-busy' : '')
          }
          onClick={() => void toggle()}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">{plugin.enabled ? '\u2713' : '\u2715'}</span>
          </span>
          <span className="settings-switch-word" aria-hidden="true">
            {toggling ? 'Working…' : plugin.enabled ? 'On' : 'Off'}
          </span>
        </button>
      </div>

      <div className="plug-cell plug-cell-actions" role="cell">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid={`plugin-configure-${plugin.id}`}
          aria-disabled={failed}
          data-tip={failed ? 'This plugin did not start, so there is nothing to set up.' : undefined}
          onClick={() => {
            if (failed) return
            onConfigure()
          }}
        >
          Configure
        </button>
        {/* UPDATE IS OFFERED ON EVERY ROW, including a plugin that came with the
            app: its new folder goes to the user's own plugins directory and is
            preferred from then on, so there is no kind of plugin here that
            cannot be replaced. The one exception is a folder too damaged to
            identify, where the id is a guess and there is nothing to match the
            chosen folder against. */}
        <button
          type="button"
          className={`btn btn-secondary btn-sm${updating ? ' plug-busy' : ''}`}
          data-testid={`plugin-update-${plugin.id}`}
          aria-disabled={updating || !plugin.removable}
          // A REPOSITORY PLUGIN REFUSES A FOLDER UPDATE, and the reason is not
          // the damaged-folder one: the repository keeps this plugin current, so
          // a folder installed here would be replaced by the next check without
          // anything on screen having said it would be. Refused honestly rather
          // than accepted and quietly undone hours later.
          data-tip={
            plugin.supplier === 'repository'
              ? 'The connected repository keeps this plugin up to date, so a folder chosen here would be replaced at the next check. Disconnect the repository first.'
              : !plugin.removable
                ? 'This folder is too damaged to identify, so there is nothing to match a new folder against. Remove it and add the new one instead.'
                : updating
                  ? 'Choosing a folder…'
                  : 'Replace this plugin’s files with another folder. Its settings are kept.'
          }
          onClick={() => {
            if (updating || !plugin.removable) return
            void update()
          }}
        >
          {updating ? 'Updating…' : 'Update'}
        </button>
        {confirming ? (
          <>
            {/* The CONFIRMATION is inline rather than a dialog: it is one row's
                decision, and a modal here would cover the table the user is
                deciding about. */}
            {/* THE QUESTION SAYS WHAT WILL HAPPEN, and the two answers differ.
                Removing an added plugin deletes its folder and the user gets it
                back by finding that folder again; removing one that came with
                the app only stops it being loaded, and Restore is right there
                below. Telling both the same thing would make one of them a
                surprise. */}
            <span className="plug-confirm-q">
              {plugin.origin === 'bundled'
                ? 'Stop using it? You can put it back.'
                : 'Remove it? Its folder will be deleted.'}
            </span>
            <button
              type="button"
              className={`btn btn-danger btn-sm${removing ? ' plug-busy' : ''}`}
              data-testid={`plugin-remove-confirm-${plugin.id}`}
              aria-disabled={removing}
              data-tip={removing ? 'Removing…' : undefined}
              onClick={() => {
                if (removing) return
                void remove()
              }}
            >
              {removing ? 'Removing…' : 'Remove'}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid={`plugin-remove-cancel-${plugin.id}`}
              aria-disabled={removing}
              data-tip={removing ? 'Removing — this can no longer be stopped.' : undefined}
              onClick={() => {
                if (removing) return
                setConfirming(false)
              }}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid={`plugin-remove-${plugin.id}`}
            aria-disabled={!plugin.removable}
            // TWO different refusals, and they are not interchangeable: one is a
            // folder the app cannot identify and the other is a decision the
            // user made when they connected a repository, which they can undo.
            // Switching on `supplier`, never on an id.
            data-tip={
              plugin.supplier === 'repository'
                ? REPOSITORY_LOCK_TIP
                : !plugin.removable
                  ? 'This plugin came with the app and is too damaged to identify, so it cannot be removed. Reinstalling the app replaces it.'
                  : undefined
            }
            onClick={() => {
              if (!plugin.removable) return
              setConfirming(true)
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

function PluginConfig({
  plugin,
  onBack,
  onChanged,
  onRemoved
}: {
  plugin: PluginDTO
  onBack: () => void
  onChanged: () => Promise<void>
  onRemoved: () => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [rejected, setRejected] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; sentence: string } | null>(null)
  const [setupBusy, setSetupBusy] = useState<string | null>(null)
  const [setupResult, setSetupResult] = useState<{ ok: boolean; sentence: string } | null>(null)

  const blocked = plugin.blockers.length > 0
  const dirty = Object.keys(draft).length > 0

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    setTest(null)
    try {
      const res = await window.api.configurePlugin({ pluginId: plugin.id, values: draft })
      setRejected(res.rejected)
      // Only the ACCEPTED fields leave the draft. A rejected value stays in the
      // box beside its reason, because clearing it would delete what the user
      // typed and leave them re-deriving what was wrong with it.
      setDraft((cur) => {
        const next: Record<string, string> = {}
        for (const [k, v] of Object.entries(cur)) if (res.rejected[k]) next[k] = v
        return next
      })
      if (Object.keys(res.rejected).length === 0) setSaved(true)
      await onChanged()
    } catch {
      // A plugin's own `configure` can throw, and a folder a stranger wrote can
      // throw anything at all — so this is caught and REPLACED, never shown.
      // Without it the Save button simply un-busied and said nothing, which is
      // indistinguishable from a save that worked: the user closes Settings
      // believing their relay address was stored.
      setSaveError('Those settings could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const runSetup = async (actionId: string): Promise<void> => {
    if (setupBusy !== null) return
    // WHICH button is busy, not merely that one is: the others must stay
    // pressable-looking-but-refused rather than all three reading "Working…",
    // which would say the app is doing three things.
    setSetupBusy(actionId)
    setSetupResult(null)
    try {
      setSetupResult(await window.api.runPluginSetup(plugin.id, actionId))
    } catch {
      // `runPluginSetup` is supposed to RESOLVE with `ok: false` and a sentence
      // rather than reject, so reaching this means the channel itself failed —
      // and Electron prefixes a rejected handler with the channel name, which is
      // not a thing to show anybody.
      setSetupResult({ ok: false, sentence: 'That step could not be started.' })
    } finally {
      setSetupBusy(null)
    }
    // The step changes what the plugin can say about itself — that is the whole
    // point of it — so the row is re-read rather than left showing the state
    // from before it ran.
    await onChanged()
  }

  const runTest = async (): Promise<void> => {
    if (testing) return
    setTesting(true)
    try {
      const r = await window.api.testPluginConnection(plugin.id)
      setTest({ ok: r.ok, sentence: r.sentence })
    } catch {
      // `testPluginConnection` is supposed to RESOLVE with `ok: false` and a
      // sentence; a rejection means the plugin threw instead of answering, and
      // that is still an answer the user is owed.
      setTest({ ok: false, sentence: 'That check could not be run.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="plug-detail" data-testid={`plugin-config-${plugin.id}`}>
      {/* Its own row above the title, and FIRST in the DOM — which is where a
          keyboard user reaches it, so the two orders agree. */}
      <button
        type="button"
        className="btn btn-secondary btn-sm plug-back"
        data-testid="plugin-back"
        onClick={onBack}
      >
        <span className="plug-back-arrow" aria-hidden="true">
          ←
        </span>
        All plugins
      </button>
      <div className="plug-detail-title">
        <h3 className="set-h3">{plugin.name}</h3>
        <p className="set-help">{plugin.blurb}</p>
      </div>

      {/* The consent sentence, beside the fields that make it possible: what
          leaves the machine is the whole decision being made here. */}
      <p className="plug-consent">Turning this on sends {plugin.discloses} to the address below.</p>

      {blocked && <p className="plug-blocker">{plugin.blockers[0]}</p>}

      {/* Exceptions only. A working keyring and a reachable relay say nothing. */}
      {plugin.warnings.map((w) => (
        <p key={w} className="plug-warning">
          <span className="badge badge-warn">Note</span>
          {w}
        </p>
      ))}

      <div className="set-fields plug-fields">
        {/* A plugin with no FIELDS may still have setup STEPS, and saying it has
            nothing to set up directly above two buttons that set it up is the
            panel contradicting itself. Silence unless both are empty. */}
        {plugin.params.length === 0 ? (
          plugin.setupActions.length === 0 && (
            <p className="plug-empty">This plugin has nothing to set up.</p>
          )
        ) : (
          plugin.params.map((param) => (
            <Field
              key={param.key}
              param={param}
              plugin={plugin}
              value={draft[param.key]}
              rejected={rejected[param.key]}
              onChange={(v) => {
                setSaved(false)
                setRejected((cur) => {
                  if (!cur[param.key]) return cur
                  const next = { ...cur }
                  delete next[param.key]
                  return next
                })
                setDraft((cur) => ({ ...cur, [param.key]: v }))
              }}
            />
          ))
        )}

        {/* What the setup buttons are for, from the plugin's manifest and only
            when it has any. Not a warning: it describes the ordinary path
            through a step, and putting it in the warnings would spend the
            channel hard rule 0.6 reserves for the exception. */}
        {plugin.setupHelp !== null && plugin.setupActions.length > 0 && (
          <p className="set-help plug-setup-help">{plugin.setupHelp}</p>
        )}

        <div className="set-actions">
          {/* SAVE BELONGS TO THE FIELDS. With none there is nothing it could
              ever write, and a permanently dead primary button is the loudest
              control on the panel spending its weight on an action that does
              not exist. */}
          {plugin.params.length > 0 && (
            <button
              type="button"
              className={`btn btn-primary${saving ? ' plug-busy' : ''}`}
              data-testid={`plugin-save-${plugin.id}`}
              aria-disabled={saving || !dirty}
              data-tip={saving ? 'Saving…' : !dirty ? 'Nothing has been changed yet.' : undefined}
              onClick={() => {
                if (saving || !dirty) return
                void save()
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            type="button"
            className={`btn btn-secondary${testing ? ' plug-busy' : ''}`}
            data-testid={`plugin-test-${plugin.id}`}
            aria-disabled={testing || blocked}
            data-tip={testing ? 'Contacting the relay…' : blocked ? plugin.blockers[0] : undefined}
            onClick={() => {
              if (testing || blocked) return
              void runTest()
            }}
          >
            {testing ? 'Checking…' : 'Check connection'}
          </button>
          {/* THE PLUGIN'S OWN SETUP STEPS, and its own words for them. Some
              plugins need something that is not a value in a form — registering
              with the operating system, opening a browser at a store listing —
              and without a button for it such a plugin can only describe the
              step in a warning and leave the user to do it by hand. Empty when
              the plugin offers none, which is the ordinary case. */}
          {plugin.setupActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`btn btn-secondary${setupBusy === action.id ? ' plug-busy' : ''}`}
              data-testid={`plugin-setup-${plugin.id}-${action.id}`}
              aria-disabled={setupBusy !== null}
              data-tip={
                setupBusy === action.id
                  ? 'Working…'
                  : setupBusy !== null
                    ? 'Another setup step is running.'
                    : undefined
              }
              onClick={() => {
                if (setupBusy !== null) return
                void runSetup(action.id)
              }}
            >
              {/* BOTH WORDS OCCUPY THE CELL, only one of them visible. Swapping
                  the text outright changes the button's width, and a button that
                  changes width moves its NEIGHBOURS — the same sideways shove
                  the answers were moved out of this row to stop, arriving from
                  the other direction and at the exact moment the user may be
                  reaching for the button beside it. */}
              <span className="btn-swap">
                <span className="btn-swap-face" aria-hidden={setupBusy === action.id}>
                  {action.label}
                </span>
                <span className="btn-swap-face" aria-hidden={setupBusy !== action.id}>
                  Working…
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* THE ANSWERS, BELOW THE ROW AND NOT IN IT. These sentences are long —
            a plugin's setup and connection results are prose, not a word — and
            in the row they pushed the buttons sideways as they arrived, so the
            control the user was about to press moved out from under the pointer.
            The region is always in the DOM and reserves its own height, so
            nothing above it shifts whether it is speaking or silent. */}
        {/* ONE live region for all of them, and none of them carries its own
            `role="alert"`. An alert is assertive, and an assertive node inside a
            polite region is announced twice — once by each — so a user on a
            screen reader heard every result of every button repeated. The region
            is what announces; what it contains is ordinary prose. */}
        <div className="set-answers" aria-live="polite">
          {setupResult && (
            <p
              className={`set-note ${setupResult.ok ? 'set-note-ok' : 'plug-note-bad'}`}
              data-testid={`plugin-setup-result-${plugin.id}`}
            >
              {setupResult.sentence}
            </p>
          )}
          {saved && <p className="set-note set-note-ok">Saved</p>}
          {saveError && (
            <p className="set-note plug-note-bad" data-testid={`plugin-save-error-${plugin.id}`}>
              {saveError}
            </p>
          )}
          {test && (
            <p
              className={`set-note ${test.ok ? 'set-note-ok' : 'plug-note-bad'}`}
              data-testid={`plugin-test-result-${plugin.id}`}
            >
              {test.sentence}
            </p>
          )}
        </div>
      </div>

      <RemoveFooter plugin={plugin} onRemoved={onRemoved} />
    </div>
  )
}

/**
 * Remove, at the bottom of the form rather than beside Save.
 *
 * Destructive and constructive actions that sit together are ones that get hit
 * by the wrong click. The reason it refuses is on the control, not implied by a
 * missing button — a Remove that is simply absent for the bundled plugin leaves
 * the user looking for it.
 */
function RemoveFooter({
  plugin,
  onRemoved
}: {
  plugin: PluginDTO
  onRemoved: () => Promise<void>
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="plug-danger">
      <div className="plug-danger-text">
        <span className="plug-danger-title">Remove this plugin</span>
        {/* The repository case says something ELSE, not the same sentence with a
            clause swapped: what follows the other two — that its data survives,
            so adding it back starts from something — is an answer to "will I
            lose my settings", and here the question is "why is this refusing". */}
        <span className="plug-danger-why">
          {plugin.supplier === 'repository' ? (
            REPOSITORY_LOCK_TIP
          ) : (
            <>
              {plugin.origin === 'bundled'
                ? 'It stops being loaded, including after an update that ships it again. Put it back from the bottom of the plugins list whenever you like.'
                : 'Its folder is deleted.'}{' '}
              What it has already saved into your library stays, and so do its own settings, so
              adding it back does not start from nothing.
            </>
          )}
        </span>
        {error && <span className="plug-row-error">{error}</span>}
      </div>
      {confirming ? (
        <div className="plug-danger-actions">
          <button
            type="button"
            className={`btn btn-danger btn-sm${removing ? ' plug-busy' : ''}`}
            data-testid={`plugin-detail-remove-confirm-${plugin.id}`}
            aria-disabled={removing}
            data-tip={removing ? 'Removing…' : undefined}
            onClick={() => {
              if (removing) return
              setRemoving(true)
              setError(null)
              void window.api
                .removePlugin(plugin.id)
                .then(onRemoved)
                .catch(() => {
                  setError('That plugin could not be removed.')
                  setRemoving(false)
                  setConfirming(false)
                })
            }}
          >
            {removing ? 'Removing…' : 'Yes, remove'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid={`plugin-detail-remove-cancel-${plugin.id}`}
            aria-disabled={removing}
            data-tip={removing ? 'Removing — this can no longer be stopped.' : undefined}
            onClick={() => {
              if (removing) return
              setConfirming(false)
            }}
          >
            Keep it
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid={`plugin-detail-remove-${plugin.id}`}
          aria-disabled={!plugin.removable}
          data-tip={
            plugin.supplier === 'repository'
              ? REPOSITORY_LOCK_TIP
              : !plugin.removable
                ? 'This plugin came with the app and is too damaged to identify, so it cannot be removed. Reinstalling the app replaces it.'
                : undefined
          }
          onClick={() => {
            if (!plugin.removable) return
            setConfirming(true)
          }}
        >
          Remove
        </button>
      )}
    </div>
  )
}

function Field({
  param,
  plugin,
  value,
  rejected,
  onChange
}: {
  param: PluginParamDTO
  plugin: PluginDTO
  value: string | undefined
  rejected: string | undefined
  onChange: (v: string) => void
}): JSX.Element {
  const isSecret = param.kind === 'secret'
  const stored = plugin.values[param.key]
  const placeholder = isSecret
    ? plugin.secretsSet[param.key]
      ? '••••••••'
      : (param.placeholder ?? '')
    : (param.placeholder ?? '')

  if (param.kind === 'choice' && param.options && param.options.length > 0) {
    // RADIOS, not a select. The alternatives of a choice differ in consequence
    // and each carries its own sentence; a dropdown shows one of them and hides
    // the rest behind a gesture, so the user decides between a label they can
    // read and labels they cannot.
    const current = value !== undefined ? value : stringOf(stored)
    const chosen = param.options.some((o) => o.value === current) ? current : param.options[0].value
    return (
      <fieldset className={`set-field plug-field plug-choice${rejected ? ' is-rejected' : ''}`}>
        <legend className="set-label">{param.label}</legend>
        <div className="plug-choice-options">
          {param.options.map((opt) => (
            <label
              key={opt.value}
              className={`plug-choice-opt${opt.value === chosen ? ' is-on' : ''}`}
              data-testid={`plugin-field-${plugin.id}-${param.key}-${opt.value}`}
            >
              <input
                type="radio"
                name={`plugin-${plugin.id}-${param.key}`}
                value={opt.value}
                checked={opt.value === chosen}
                aria-invalid={rejected ? true : undefined}
                onChange={() => onChange(opt.value)}
              />
              <span className="plug-choice-mark" aria-hidden="true" />
              <span className="plug-choice-text">
                <span className="plug-choice-label">{opt.label}</span>
                {opt.help && <span className="plug-choice-help">{opt.help}</span>}
              </span>
            </label>
          ))}
        </div>
        {rejected ? (
          <span className="plug-field-bad" data-testid={`plugin-field-bad-${plugin.id}-${param.key}`}>
            {rejected}
          </span>
        ) : (
          <span className="plug-help">{param.help}</span>
        )}
      </fieldset>
    )
  }

  if (param.kind === 'boolean') {
    const on = value !== undefined ? value === 'true' : stored === true
    return (
      <label className={`set-field plug-field${rejected ? ' is-rejected' : ''}`}>
        <span className="set-label">{param.label}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-invalid={rejected ? true : undefined}
          className={`settings-switch${on ? ' is-on' : ''}`}
          data-testid={`plugin-field-${plugin.id}-${param.key}`}
          onClick={() => onChange(on ? 'false' : 'true')}
        >
          <span className="settings-switch-track" aria-hidden="true">
            <span className="settings-switch-knob">{on ? '\u2713' : '\u2715'}</span>
          </span>
          <span className="settings-switch-word" aria-hidden="true">
            {on ? 'On' : 'Off'}
          </span>
        </button>
        {rejected ? (
          <span className="plug-field-bad" data-testid={`plugin-field-bad-${plugin.id}-${param.key}`}>
            {rejected}
          </span>
        ) : (
          <span className="plug-help">{param.help}</span>
        )}
      </label>
    )
  }

  return (
    <label className={`set-field plug-field${rejected ? ' is-rejected' : ''}`}>
      <span className="set-label">
        {param.label}
        {/* Only the OPTIONAL ones are marked. Required is what a settings field
            ordinarily is, and marking every one of those would spend the row on
            saying nothing. */}
        {!param.required && <span className="plug-optional">optional</span>}
      </span>
      <input
        className="input"
        type={isSecret ? 'password' : param.kind === 'number' ? 'number' : 'text'}
        inputMode={param.kind === 'number' ? 'numeric' : undefined}
        data-testid={`plugin-field-${plugin.id}-${param.key}`}
        placeholder={placeholder}
        aria-invalid={rejected ? true : undefined}
        value={value !== undefined ? value : isSecret ? '' : stringOf(stored)}
        onChange={(e) => onChange(e.target.value)}
      />
      {rejected ? (
        <span className="plug-field-bad" data-testid={`plugin-field-bad-${plugin.id}-${param.key}`}>
          {rejected}
        </span>
      ) : (
        <span className="plug-help">{param.help}</span>
      )}
    </label>
  )
}

function stringOf(v: string | number | boolean | null): string {
  if (v === null) return ''
  return String(v)
}
