// Plugin DTOs — the generic shape the Settings → Plugins pane renders.
//
// Part of the frozen IPC contract; `contract.ts` re-exports everything here.
//
// GENERIC ON PURPOSE. The pane iterates `PluginDTO[]` and renders a field per
// declared param, switching on `kind`. It knows nothing about any one plugin,
// so a second plugin costs no renderer change at all — and, more importantly,
// no plugin can smuggle a bespoke control into Settings that the audit gates
// have never seen.
//
// A SECRET VALUE NEVER CROSSES THIS BOUNDARY. `values` carries the non-secret
// parameters only; whether a secret is set is a boolean in `secretsSet`. This
// mirrors `GatewayConfigDTO.hasKey`, which exists for the same reason: an IPC
// payload is structured-cloned into a renderer that can be opened with devtools.

/** What kind of control a parameter gets, and how it is validated. */
export type PluginParamKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'secret'
  | 'url'
  | 'path'
  | 'choice'

/**
 * One alternative of a `choice` param.
 *
 * A CLOSED SET rather than a free string, because the whole value of the kind is
 * that the renderer can show every alternative at once: a user choosing between
 * two named behaviours should not have to know that "on-demand" is spelled with
 * a hyphen. `help` is per-option because the alternatives of a genuine choice
 * differ in consequence, and a single sentence under the group can only describe
 * one of them.
 */
export interface PluginParamOptionDTO {
  value: string
  label: string
  /** One sentence for THIS alternative, or absent. */
  help?: string
}

export interface PluginParamDTO {
  key: string
  label: string
  kind: PluginParamKind
  required: boolean
  /** One sentence under the field. Prose, not a badge — see hard rule 0.6. */
  help: string
  placeholder?: string
  /** Present exactly when `kind` is `choice`, and then never empty. */
  options?: PluginParamOptionDTO[]
}

/**
 * The lifecycle state of a plugin, as one closed enum.
 *
 * `off` is not a failure and gets no badge. `needs-credentials` is terminal
 * until the user edits Settings, which is why it is distinct from `failed`:
 * one is fixed by waiting, the other is not.
 */
export type PluginRunState =
  | 'off'
  | 'idle'
  | 'syncing'
  | 'ok'
  | 'resync'
  | 'failed'
  | 'needs-credentials'

export interface PluginStatusDTO {
  state: PluginRunState
  /**
   * The ONE sentence for the current state, already mapped from a closed error
   * enum in main. Never an exception message: undici errors carry the request
   * URL and sometimes headers, and this string is rendered verbatim.
   */
  sentence: string | null
  /** The enum code behind `sentence`, for the renderer to key styling on. */
  code: string | null
  /** ISO-8601, or null when this plugin has never completed a cycle. */
  lastOkAt: string | null
}

/**
 * A CAPABILITY a plugin offers beyond the generic lifecycle — the thing the app
 * gates an entry point on.
 *
 * THE RENDERER MUST NEVER NAME A PLUGIN. A screen that gated an entry point on a
 * plugin's id would make that plugin's name part of the UI's source, so a second
 * plugin offering the same thing — or the same one renamed — would render no
 * entry point at all, with nothing on screen to explain why. A capability is the
 * honest question the button is asking: "is there anything here that can share a
 * project?", not "is that one particular folder installed?".
 *
 * A CLOSED SET, not a free string, and DERIVED IN MAIN from the verbs the loaded
 * module actually offers rather than claimed by the manifest. A plugin cannot
 * therefore advertise a capability it does not implement and have the app open a
 * screen that then fails on its first call — which is the failure a declarative
 * `provides: [...]` in `plugin.json` would allow. Adding a member here is the
 * deliberate act of saying "the app has a surface for this".
 */
export type PluginCapability =
  | 'project-sharing'
  | 'paper-search'
  | 'paper-retrieval'
  /**
   * The plugin has a SETUP STEP that cannot be a form field.
   *
   * Configuration is params, and the pane renders those generically. Some
   * plugins need something that is not a value: registering with the operating
   * system, opening a browser at a store listing, writing a file another program
   * reads. Without a surface for it, such a plugin can only describe the step in
   * a warning sentence and leave the user to perform it by hand — which is a
   * plugin that reports itself broken and offers no way to fix it.
   *
   * The app knows nothing about WHAT the step does. It renders a button per
   * action the plugin lists, the plugin's own `blockers`/`status` say whether it
   * is still needed, and the only thing crossing back is a shaped sentence.
   */
  | 'plugin-setup'

/**
 * One setup step, as a button.
 *
 * The `id` is the plugin's own name for the step and is the ONLY thing the app
 * passes back when the button is pressed — it is never a URL, a path or a
 * command. The app cannot construct one: it renders what it was given and
 * returns it, so the set of things this button can do is closed by the plugin
 * that listed them, not opened by the renderer that displays them.
 */
export interface PluginSetupActionDTO {
  /** A slug. Keyed on as a React key and a test id, never read as prose. */
  id: string
  /** The word on the button. THE PLUGIN'S, because the app has none to guess. */
  label: string
}

/**
 * What a paper-search call rejects with when nothing installed can answer it.
 *
 * A contract-owned literal matched by identity on both sides, exactly like
 * `SHARING_OFF_SENTENCE` below, and NAMING NO PLUGIN for the same reason:
 * searching for new papers is a capability, not a product, and telling a user to
 * turn on something they have never installed is the failure that rule exists
 * for.
 */
export const PAPER_SEARCH_OFF_SENTENCE =
  'Nothing installed can search for new papers. Add a plugin that can, in Settings → Plugins.'

/** The same, for fetching a PDF. Read by the retrieval stage and shown on the queue. */
export const PAPER_RETRIEVAL_OFF_SENTENCE =
  'Nothing installed can fetch PDFs. Add a plugin that can, in Settings → Plugins.'

/**
 * What a sharing call rejects with when the plugin providing it is switched off.
 *
 * IN THE CONTRACT, not in either half, because both halves match it BY IDENTITY:
 * main lets it out through its closed set, and the renderer checks a rejection
 * against the same set before rendering it verbatim. Two copies of the literal
 * drift, and the symptom of drift is silent — the renderer stops recognising a
 * sentence written for the user and shows its vague fallback instead.
 *
 * It NAMES NO PLUGIN. Naming one put a plugin's name in the app's
 * own prose, so a user running a different sharing plugin was told to enable one
 * they had never installed and Settings showed them no such row.
 */
export const SHARING_OFF_SENTENCE =
  'The plugin that shares projects is switched off. Turn it on in Settings → Plugins.'

/**
 * What `listShares` rejects with when NOTHING that shares could be asked.
 *
 * Same contract-owned literal, matched by identity on both sides, for the same
 * reason. It exists because an empty list is an ANSWER — "none of your projects
 * is shared" — and a plugin that raised when asked has not given one. Resolving
 * to `[]` drew every shared project as private while it went on syncing, which
 * is the one state the sharing UI must never be able to reach.
 *
 * A PARTIAL failure does not use this: the shares that could be read are still
 * reported, and the failing plugin's own row in Settings says what is wrong
 * with it. This is only for the total case, where there is no picture at all.
 */
export const SHARING_UNREADABLE_SENTENCE =
  'Sharing could not be read, so this may not be the full picture. Check Settings → Plugins.'

export interface PluginDTO {
  id: string
  name: string
  blurb: string
  /**
   * Named in the enable-consent sentence: what leaves this machine if the user
   * turns this on. Rendered as prose beside the toggle.
   */
  discloses: string
  enabled: boolean
  /**
   * Always true for a row in THIS list — every one of them is something on disk
   * that discovery accepted.
   *
   * A removed bundled plugin is NOT represented here with `installed: false`. It
   * has its own list (`PluginRemovedDTO`), because "the user took this out" and
   * "this is in a catalogue and not yet added" are different answers that would
   * otherwise share one field, and the table would have to guess which it was
   * looking at.
   */
  installed: boolean
  /**
   * Whether Remove applies.
   *
   * TRUE FOR EVERY ROW THAT LOADED, including a bundled one. A plugin is a
   * plugin, not a native part of the app: what differs is what removing MEANS.
   * An added plugin's folder is deleted; a bundled folder lives inside the
   * installation and may be root-owned, so it is tombstoned instead — discovery
   * skips it from then on, across restarts and across an upgrade that re-ships
   * the folder, and Restore clears the record.
   *
   * `false` in exactly two cases. A BROKEN BUNDLED folder: its manifest never
   * parsed, so there is no id to tombstone and nothing that would make the skip
   * stick. And a plugin the connected REPOSITORY supplied, which is released by
   * disconnecting rather than row by row — see `supplier`.
   */
  removable: boolean
  /**
   * WHO SUPPLIED this plugin, which is a different question from `origin`.
   *
   * `origin` says which folder on disk it was loaded from, and decides what
   * removing it does. This says who decided it should be here, and decides
   * whether removing it is the user's to do at all. They are orthogonal: a
   * repository plugin lives under the added root and is still not removable.
   *
   * `repository` is the ONE value that takes Remove away, and it is a deliberate
   * reversal of the rule that there is no part of this app the user may not take
   * out. What replaces it is narrower and is what the user was actually asked
   * about: connecting to a repository was consent to take its whole SET, so the
   * app keeps the set, and the user keeps authority over what EXECUTES through
   * the Off toggle, which is untouched. Disconnecting releases every lock and
   * leaves the plugins installed as ordinary ones.
   *
   * THE RENDERER SWITCHES ON THIS, never on an id.
   */
  supplier: 'user' | 'bundled' | 'repository'
  /** Where it came from. Decides what Remove does, and the sentence that says so. */
  origin: 'bundled' | 'added'
  /** The manifest's version, or null for a folder that failed to load. */
  version: string | null
  /**
   * The folder it was loaded from.
   *
   * Shown because "which plugin is this?" must have an answer the user can check
   * on disk — two folders can declare the same name, and the id is not enough to
   * find one of them.
   */
  dir: string
  /**
   * Why this folder could not be loaded, or null.
   *
   * A broken plugin still gets a ROW: one the user installed and then cannot
   * find is indistinguishable from one the app lost, and there would be nothing
   * to click to remove it.
   */
  failedToLoad: string | null
  params: PluginParamDTO[]
  /** Non-secret values only, keyed by param key. */
  values: Record<string, string | number | boolean | null>
  /** Whether each `secret` param has a value stored. NEVER the value. */
  secretsSet: Record<string, boolean>
  /**
   * Why this plugin cannot be enabled right now, in the user's words. Non-empty
   * means the toggle is `disabled` with the first entry as its `data-tip` —
   * a disabled control must explain itself (hard rule 0.5).
   */
  blockers: string[]
  /**
   * Warnings that are true whether or not the plugin is enabled, e.g. "the OS
   * keyring is unavailable, so the password rests on file permissions alone".
   * Exceptions only: an empty array is the ordinary case.
   */
  warnings: string[]
  /**
   * What this plugin can do that the app has a surface for. Empty for a plugin
   * that only ticks, and empty for a broken folder — a plugin whose code never
   * loaded offers nothing, whatever its manifest says.
   */
  capabilities: PluginCapability[]
  /**
   * This plugin's setup steps, one button each. EMPTY for no such step.
   *
   * FROM THE PLUGIN, because only it knows what a step does — installing an
   * extension, registering with the operating system, opening a store listing
   * are not the same act and must not share a label the app guessed. An empty
   * list draws no button at all: a control the app had to name is one whose
   * effect the user cannot predict.
   *
   * A LIST rather than one label, because one step can honestly have several
   * destinations — the same registration followed by a different store — and the
   * app must not be what knows which stores exist. One button would make it
   * either choose for the user or name the choices in its own prose.
   */
  setupActions: PluginSetupActionDTO[]
  /**
   * One sentence introducing those buttons, or null.
   *
   * FROM THE MANIFEST, not from a verb: it is description, and description is
   * read without running a plugin's code. It is NOT a warning — hard rule 0.6
   * keeps that channel for the exception — so it says what the buttons are for
   * and disappears entirely with them.
   */
  setupHelp: string | null
  status: PluginStatusDTO
}

/**
 * A bundled plugin the user removed, and which is therefore not loaded.
 *
 * IT MUST HAVE A ROW SOMEWHERE. A bundled folder cannot be deleted — it is
 * inside the installation and may be root-owned — so removal is a record in the
 * database that discovery honours. That record survives an upgrade which
 * re-ships the folder, which is the property the user asked for; but a decision
 * that outlives the thing it was made about, with nothing on screen naming it, is
 * a plugin the app quietly refuses to load forever and no way to change one's
 * mind.
 *
 * DELIBERATELY THIN. The manifest is not read for these — the whole point is
 * that the folder is not inspected — so the id is the only identity there is,
 * and the renderer shows it as such rather than pretending to a name.
 */
export interface PluginRemovedDTO {
  id: string
  /** Whether a folder with this id is actually present to restore. */
  present: boolean
}

/** What the Plugins pane renders: what is here, and what was taken out. */
export interface PluginListDTO {
  plugins: PluginDTO[]
  /** Empty in the ordinary case, which renders nothing at all (hard rule 0.6). */
  removed: PluginRemovedDTO[]
}

/** What `plugins:configure` accepts. `undefined` = leave, `''` = clear. */
export interface PluginConfigureInputDTO {
  pluginId: string
  values: Record<string, string | number | boolean>
}

/** The outcome of writing config: which values the plugin refused, and why. */
export interface PluginConfigureResultDTO {
  plugin: PluginDTO
  /** Keyed by param key. Empty when everything was accepted. */
  rejected: Record<string, string>
}

/**
 * What choosing a folder in the native picker came back with.
 *
 * THREE outcomes, distinguished rather than collapsed. Cancelling is not a
 * failure and must show nothing at all; a refusal is a sentence the user acts
 * on; success is a row in the table. Folding cancel into "no plugin" would pop
 * an error every time somebody changed their mind, and folding a refusal into a
 * rejected promise would put a raw `Error:` and the chosen path in front of
 * them.
 */
export interface PluginInstallResultDTO {
  cancelled: boolean
  /** The newly installed plugin, or null if cancelled or refused. */
  plugin: PluginDTO | null
  /** A whole sentence saying why the folder was refused. Never a raw error. */
  reason: string | null
}

/**
 * What asking for a sync did.
 *
 * `started: false` is the ORDINARY answer to a second click while the first
 * cycle is still going, not a failure — so it carries no sentence and the caller
 * simply keeps showing the busy control. A refusal the user has to act on (the
 * plugin is off, nothing is shared) is a rejected promise with a sentence, the
 * same as every other verb here.
 */
export interface SyncNowResultDTO {
  /** Whether this call ran a cycle, or found one already in flight. */
  started: boolean
}

/**
 * WHAT THE USER AGREES TO BY CONNECTING A PLUGIN REPOSITORY.
 *
 * IN THE CONTRACT, matched by identity on both sides, exactly like the off-
 * sentences above — and here for a stronger reason than drift. This is the
 * consent itself. A sentence that lives only in a component is one that can be
 * shortened by somebody adjusting a layout, and the thing it would be shortened
 * out of is the part that costs the user something.
 *
 * It says the three things a reader cannot infer and would otherwise discover
 * afterwards: EVERYTHING is installed, with no per-plugin choice; the plugins
 * are not sandboxed (there is no trust boundary after install); and therefore
 * whoever controls the repository chooses what runs on this computer.
 */
export const REPOSITORY_CONSENT_SENTENCE =
  'Everything this repository offers will be installed and kept up to date automatically. '
  + 'Its plugins run with the same access to your library as the app itself, and whoever controls '
  + 'it chooses what runs on this computer. Connect only a repository you trust.'

/**
 * The connected plugin repository, or the absence of one.
 *
 * THE KEY IS NEVER HERE — only `hasKey`, the same shape `GatewayConfigDTO` uses
 * and for the same reason: an IPC payload is structured-cloned into a renderer
 * that can be opened with devtools. The key is a bearer credential for a channel
 * whose contents are executed on this machine.
 *
 * ONE repository, not a list: two could offer the same id, and the app would
 * have to decide which supplier wins — a decision nobody can be asked to make in
 * a settings pane, and whose wrong answer is a silent substitution of code.
 */
export interface PluginRepositoryDTO {
  /** The address, or '' when nothing is connected. Safe to show. */
  address: string
  /** Whether a key is stored. NEVER the key. */
  hasKey: boolean
  /** Both an address and a key are held, so cycles run. */
  connected: boolean
  /** ISO-8601 of the last check that SUCCEEDED, or null. */
  lastCheckedAt: string | null
  /**
   * What went wrong last time, or null.
   *
   * THE EXCEPTION ONLY (hard rule 0.6): a healthy repository says nothing, gets
   * no green badge, and shows its address and when it last checked. Never an
   * exception message — a fetch error carries the request URL and, on this path,
   * the authorization header with it.
   */
  sentence: string | null
  /** The enum code behind `sentence`, for the renderer to key styling on. */
  code: string | null
  /**
   * Plugins the repository offers and this app deliberately did not install,
   * one sentence each — built for a later version of the app, or removed by the
   * user. EMPTY is the ordinary case and renders nothing.
   *
   * They are here rather than silent because the alternative is a repository
   * that reports itself fully applied while a plugin the user was promised is
   * missing, with nothing on screen to say why.
   */
  skipped: string[]
  /** How many installed plugins this repository supplies. */
  supplied: number
}

/** What a repository probe answers: whether it is there, and how much it holds. */
export interface PluginRepositoryTestDTO {
  ok: boolean
  sentence: string
  code: string | null
  /** How many plugins the index lists. Zero unless `ok`. */
  plugins: number
}

/** A live connection probe. Never carries a raw error. */
export interface PluginTestResultDTO {
  ok: boolean
  sentence: string
  code: string | null
}

/**
 * A project this install shares with peers.
 *
 * `ProjectDTO` is deliberately NOT extended: shared-ness is one plugin's
 * interpretation of a project, and the core contract carries no plugin state.
 * The Projects screen asks for this list separately and renders nothing extra
 * when it comes back empty — which is the fresh-install case.
 */
export interface SharedProjectDTO {
  projectId: number
  /** 'origin' minted the room; 'replica' joined one. */
  role: 'origin' | 'replica'
  state: PluginRunState
  /** True when local and remote hashes agree — i.e. nothing left to merge. */
  inSync: boolean
  /**
   * True when the user has set syncing to happen only when they ask for it.
   *
   * The navbar indicator becomes a BUTTON when this is set, so it is on the DTO
   * rather than read from the plugin's config by the renderer: the renderer has
   * no business knowing that a plugin spells this mode "on-demand", and a
   * second plugin offering the same choice would otherwise need its own branch
   * up there.
   */
  onDemand: boolean
  /** The relay this project is shared through, for a tooltip. Never a room id. */
  relayLabel: string | null
  sentence: string | null
  code: string | null
  lastOkAt: string | null
  /**
   * Rows the other computer offered that THIS one cannot store, and which this
   * copy is therefore permanently missing.
   *
   * `0` on a healthy share, which is the ordinary case: render NOTHING for it.
   * A badge announces the exception (hard rule 0.6), and this is one the user
   * has to act on — usually by updating the app, occasionally by freeing an
   * identifier a local paper already holds. Silence would be a corpus reporting
   * itself in sync while it is short, which is the one failure this feature is
   * not allowed to have.
   *
   * A COUNT, never the rows: their content belongs to a peer.
   */
  declinedRows: number
}

/**
 * What joining a colleague's project needs: their invitation, and a name for the
 * copy that lands here.
 *
 * The NAME is asked for rather than carried by the invitation because
 * `project.name` is scoped out of last-write-wins — one user renaming their copy
 * must not rename everyone's — so a replica has no name to inherit.
 */
export interface JoinProjectInputDTO {
  /** The string the sharer copied. It is a SECRET: it grants read access. */
  invite: string
  name: string
}

/** What sharing a project hands back — including the invite, ONCE. */
export interface ShareResultDTO {
  share: SharedProjectDTO
  /**
   * The room id, shown exactly once and never returned again.
   *
   * It is the read capability for the whole project, so it is excluded from
   * every other DTO, from project archives and from outlet exports. A caller
   * that loses it re-keys the room rather than asking for it back.
   */
  invite: string
}
