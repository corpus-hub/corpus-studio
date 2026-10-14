# The plugin host — what a plugin is, and what it is allowed to reach

A plugin is a FOLDER with a `plugin.json` and an entry module. The host discovers
them at startup from two roots and `require`s the entry module named by the
manifest. Nothing is compiled in: a plugin the app ships and one the user dropped
in travel the identical path, which is the only way the install path is ever
actually exercised.

- **bundled** — `<repo>/plugins` in dev, `<resourcesPath>/app-resources/plugins`
  when packaged (`electron-builder.yml` maps `plugins/` → `app-resources/`).
  Removable, but not DELETABLE: the folder is outside the writable root, so
  removing one records `plugin.<id>.removed` and discovery skips the id before
  reading its manifest. In the DATABASE, so it survives an update that re-ships
  the folder — which is the property that makes it a removal rather than a
  hidden row — and in BOTH roots, or dropping a same-id folder into the user
  root would undo the user's decision. Settings has a "Removed" section to put
  one back. **A shipped plugin's id is FROZEN**: renaming it resurrects a
  removal the user made.
- **added** — `<userData>/plugins/<id>`, what `addPluginFromFolder()` copies into.

- **repository** — also `<userData>/plugins/<id>`, but installed by a connected
  plugin repository rather than by the user, and marked `plugin.<id>.source =
  repository` in `setting`. See below: it is the one plugin the user may NOT
  remove.

Both roots are overridable (`CORPUS_BUNDLED_PLUGINS_DIR`, `CORPUS_PLUGINS_DIR`),
which is how the tests get an isolated set.

## A REPOSITORY PLUGIN CANNOT BE REMOVED — the one exception, and its price

There used to be no such thing here as a part of the app the user may not take
out. Connecting a plugin repository reverses that, deliberately, and this
paragraph is the amendment rather than a note beside a rule it contradicts: a
rule left standing while shipped code disagrees with it is worse than either
half, because the next reader trusts the wrong one.

A repository is a SET, and connecting to one is consent to take the set —
everything it offers, installed and kept current, with no per-plugin prompt. So
one of its plugins is not the user's to remove one at a time, and the next cycle
would reinstall it in any case. `removePlugin` REFUSES a `repository`-sourced id
in main, and `plugins:updateFromFolder` refuses one too — a folder installed by
hand would be silently replaced at the next check.

What replaces the old rule is narrower and is the thing the user was actually
asked about: **they keep authority over what EXECUTES.** The Off toggle is
untouched, so a repository plugin can be installed, kept current, and running
nothing. What they gave up is authority over what is INSTALLED.

**Disconnecting is the escape hatch and the only one**, so it is a plain button
on the card. It clears every `plugin.<id>.source` and the stored key; the plugins
stay installed and become ordinary user plugins, Remove returns, updates stop.
Nothing anyone relies on breaks at the moment they take it. Uninstalling them
instead would mean escaping one plugin costs every other one with it.

The renderer switches on `PluginDTO.supplier` and `removable`, never on an id —
the naming rule below is unchanged and binds this too. `repository.ts` carries
the fetch/verify/apply cycle and `unzip.ts` the bounded extractor, which is the
one genuinely new attack surface on that path; everything after the unpack is
the SAME `installPluginFolder`/`updatePluginFolder` a chosen folder goes through,
because the copy of that logic which gets dropped is the one somebody exploits.

| | |
|---|---|
| manifest schema + caps + refusals | `manifest.ts` |
| discovery, install, uninstall | `{loader,install,paths}.ts` |
| enable/disable, the TICK timer, crash isolation | `host.ts` |
| what a plugin must implement | `types.ts` |
| the DTOs the Settings pane renders | `src/shared/contract/plugins.ts` |
| a plugin's own source | its folder, which carries its own notes |

## THE TRUST BOUNDARY: THERE IS NONE AFTER INSTALL

An installed plugin runs in the Electron MAIN process with this app's full
privileges — the whole Node API, the user's filesystem, the network, and the same
`PluginCtx.db` handle the app itself uses. Manifest validation stops a MISTAKE (a
wrong folder, a half-copied tree) and stops the act of *inspecting* an untrusted
folder from being the exploit (no traversal, no symlinks, no absolute entry
paths, bounded size). It is NOT a sandbox and must never be read as one.
`manifest.ts`'s header block is the long version — read it before touching the
installer — and the Plugins pane says the user-facing half out loud: a plugin
"runs with the same access to your library as the app itself — install only ones
you trust, as you would any program".

## Description is read WITHOUT running the code

Name, blurb, disclosure and params come from `plugin.json`, never from the
returned object: the installer must render a plugin's identity and configuration
form BEFORE deciding whether to load it, and a plugin that can only describe
itself by running is one that gets to run before it is trusted.

## Neither the renderer nor main may NAME a plugin

Settings → Plugins is fully generic — a field per declared param, switching on
`kind` — and an entry point elsewhere is gated on a `PluginCapability`
(`project-sharing`, `paper-search`, `paper-retrieval`), derived in main from the
verbs the loaded module actually offers, never on an id literal and never on
something the manifest merely claims. That is why `plugin.json` gained no
`views` or `tools` array when the Ingest tab and the `search_web` tool became
plugin-backed: the capability already decides both, and a declaration would let
a manifest put a tab on screen that fails on its first press.
`ProjectsScreen` gating on a hard-coded plugin id shipped and is the failure
this rule exists for: a second sharing plugin, or the same one renamed, would
have rendered no entry point and nothing to say why.

MAIN is held to the same rule. The five sharing channels (`listShares`,
`shareProject`, `joinProject`, `unshareProject`, `syncNow`) resolve the plugin
from the `project-sharing` capability AT CALL TIME
(`enabledPluginsWithCapability`), so the id the app dispatches to and the
capability the entry point is gated on are the same question. With TWO such
plugins the app is honest rather than arbitrary: `listShares` UNIONS them and
`syncNow` ticks all the enabled ones, `unshareProject` routes to the plugin that
actually holds the share, and `shareProject` refuses a project another plugin
already shares. Picking the first would hide the second's projects while they
went on syncing with nothing on screen to stop them. A hard-coded sharing id made
them disagree twice over: a second sharing plugin lit the entry point and was
refused by every call, and the refusal told the user to turn on a plugin they had
never installed and which Settings showed them no row for.

The off-sentence is `SHARING_OFF_SENTENCE` in the contract, naming no plugin, so
main and the renderer match ONE literal by identity rather than two copies that
drift — a sentence the renderer stops recognising is silently replaced by its
vague fallback.

A verb that ACTS goes through `pluginActingVerb`, which re-reads the enabled flag
inside the lifecycle chain: without it a disable arriving mid-call produced a
share that exists and never syncs. Reads do not, because what is shared is in the
database whether or not anything is polling.

A LONG verb goes through `pluginCapabilityVerb` instead, and must NOT join that
chain. `serialised` is strict FIFO, so putting a five-minute search or a one-hour
retrieval in it leaves the user's Off toggle unresponsive for the duration, holds
`lifecycleBusy` above zero (suppressing every tick), and serialises the queue's
parallel retrievals against each other. It rebuilds the guarantee from the two
pieces that matter: the enabled flag, the retirement flag, `lifecycleBusy` and
the ABORTED SIGNAL are all read in one synchronous turn before the verb is
entered, and the promise is parked in `slot.work`, which `leaveEnabled` aborts
and then drains and `pluginsInFlightCount()` counts. The signal rather than the
flag is the gate because two teardowns never clear the flag — `configure`
restarts the plugin, and the quit path writes no settings.

## Every plugin-authored string is SHAPED at the boundary

Never trusted, and never filtered in the renderer. `host.ts` exports
`shapeSentence` / `shapeLabel` / `shapeCode` / `shapeIso` / `shapeRunState`, and
everything a plugin can put on screen goes through them: `blockers[]` and
`warnings[]` (`sentences()`), `status()` (`shapeStatus`), `testConnection()`,
`values()`/`secretsSet()` and `configure().rejected` — all three keyed back
against the DECLARED params — the broken-folder `reason`, and every field of
`SharedProjectDTO` (`shapeShare` in `src/main/index.ts`, including `relayLabel`
and the invite). `shapeShare` builds the DTO FIELD BY FIELD rather than spreading
the plugin's object, so the safe default for the next field added is that it does
not cross at all.

Bounded length, no control or bidi characters, codes restricted to a slug because
the renderer keys STYLING on them, states checked against the enum because an
unknown member falls through to whatever the last `else` renders. The trust model
is "a folder a stranger wrote": without this, a stack trace, an absolute path
(and so the OS username) or a URL reaches a tooltip verbatim.

Each shaper also SWALLOWS a throw, because these are called from `listPlugins()`:
an escaping exception rejects `plugins:list` and leaves Settings stuck on
"Reading…" for every plugin, so one hostile folder blanks the pane for all of
them. For the same reason `capabilitiesOf` guards its property reads — they run a
stranger's getters.

WHAT IS STILL UNBOUNDED, and cannot be fixed here: `PluginCtx.db` is the app's own
write handle, so a plugin can put anything into a project name, a work title or a
setting that some other screen renders. That is the trust boundary saying what it
says — there is none after install — not an oversight for a shaper to close.

## The HOST owns the timer

A plugin exposes `tick`; it never schedules itself. One in-flight promise per
plugin, and a tick that fires while one is unresolved is DROPPED, never queued —
better-sqlite3 is synchronous on one shared connection, so overlapping ticks
corrupt the first one's view of what it already decided.
