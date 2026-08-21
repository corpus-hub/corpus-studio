# Driving Corpus Studio from an AI assistant

Corpus Studio can expose its own features as **MCP tools**, so an assistant like
Claude can search your corpus, read a paper's extracted facts, record a review
verdict or re-run a stage — the same operations you do by clicking.

It is **off by default**. Turning it on opens a listening socket on your machine;
read [Security](#security) before you do.

Every tool, with its arguments and what it returns: **[mcp-tools.md](./mcp-tools.md)**
(generated from the code — `npm run docs:mcp`).

---

## Turn it on

**Settings → MCP.**

1. Flick **Enable MCP server**. The word beside the switch goes `Off` → `Starting`
   → `Listening` (and `Serving` while a call is in progress).
2. Copy the **config block** underneath. Pick the tab that matches your client:
   **Claude**, **VS Code** or **stdio shim**. It already contains the address and
   your token.
3. Paste it into your client's MCP config and restart the client.
4. Ask your assistant to call `health`. It reports how many projects and papers
   it can see — that is how you know it reached the right corpus.

The status line shows the last tool called and when. **The server only runs while
Corpus Studio is open**; close the app and your assistant's connection dies.

### Advanced (disclosure below the addresses)

| Control | What it does |
|---|---|
| **Port** | Default `51820`. Editable while the server is stopped or running; changing it while running shows *restart to apply*. |
| **Accept connections from other machines** | Binds `0.0.0.0` instead of `127.0.0.1`. See [Security](#security). |
| **Let the agent make changes** | On by default. Unlocks the `write` tools. |
| **Let the agent delete things and write files** | Off by default. Unlocks the `destructive` tools. Requires the previous one. |
| **Access token** | Reveal, copy, or regenerate. Regenerating invalidates every config you already pasted. |
| **Show the call log in folder** | Opens the audit log directory. |

---

## Permission levels

Three levels, from the two checkboxes above. **A tool above the level is not
listed and not callable** — your assistant never sees it.

| Level | Both boxes | Tools | What it unlocks |
|---|---|---|---|
| **Read** | both off | 46 | Search, read papers, extracted rows, rankings, dossier, queue state. Nothing changes. |
| **Read + write** | changes on | 64 | +18: review verdicts, ranking overrides, schema attach/detach, queue pause/resume, dossier build, extraction and summary runs — and `search_web`. |
| **Read + write + delete** | both on | 71 | +7: `paper_delete`, `schema_delete`, `schema_field_delete`, `job_cancel`, `paper_reprocess`, `paper_stage_rerun`, `outlet_action_run`. |

(70 registry tools plus `health`, which every level can call.)

Two placements are deliberate and may surprise you:

- **`search_web` is `write`, not `read`.** It changes nothing here, but the query
  text *leaves the machine* to third-party indexes — so it is filed under the
  checkbox you would turn off to keep everything local.
- **`paper_reprocess`, `paper_stage_rerun` and `job_cancel` are `destructive`.**
  Each throws away analysis output — including, for the first two, analyses other
  projects made of the same paper. The work is re-planned, not lost forever, but
  another project pays for the re-analysis.

The level is checked when tools are listed **and again on every call**, so
lowering it bites immediately — the assistant does not have to re-list first.

---

## Security

This app is otherwise strictly offline and local-first. Enabling MCP opens the
app's **first inbound listening socket** — it makes no new outbound connections,
it can now accept one.

- **Loopback by default.** Bound to `127.0.0.1` — the address that means "this
  machine only". Nothing on your network can reach it.
- **The token is required, always.** Every request needs
  `Authorization: Bearer <token>`. There is no unauthenticated mode.
- **The token is a full capability.** Whoever holds it can do everything you can
  do in this app, at the level you granted. It is stored in `mcp.token` in the
  app's data directory, mode `0600`, never in the database and never in the
  status the Settings pane polls. Regenerate it if it leaks.
- **LAN mode is plain HTTP, unencrypted.** Ticking *accept connections from other
  machines on your network* binds `0.0.0.0` instead. The token and your papers'
  text then cross the network in the clear, readable by anyone who can watch it.
  Only do this on a network you trust.
- **Browsers are refused.** Any request carrying an `Origin` header is rejected,
  so a web page open on your machine cannot drive your corpus.
- **Destructive tools are off unless you turn them on**, and so are writes if you
  turn them off.
- **Every call is logged**, always, while the server runs — one JSONL file per day
  in `mcp-audit/` in the app's data directory (`Show the call log in folder`).
  Arguments are recorded for writes only, truncated to 500 characters. Tokens
  never appear in it.
- A refused request — bad token, unrecognised host, `Origin` present — answers an
  identical blank `401`, so a scan learns nothing from which one it hit. More
  than 10 refusals in a minute from the same caller blocks it for five minutes;
  the whole server is capped at 300 requests a minute, answering `429` past that.

---

## Connect

Endpoint: `http://127.0.0.1:51820/mcp` · transport: **Streamable HTTP** (POST
only) · header: `Authorization: Bearer <token>`.

Generic client:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:51820/mcp",
  "headers": { "Authorization": "Bearer PASTE_YOUR_TOKEN" }
}
```

Claude Code takes the same thing wrapped in `mcpServers` (the **Claude** tab), or
from a shell:

```bash
claude mcp add --transport http corpus-studio http://127.0.0.1:51820/mcp \
  --header "Authorization: Bearer PASTE_YOUR_TOKEN"
```

**Claude Desktop cannot speak HTTP** — it needs the **stdio shim** tab, which
runs `mcp-remote` as a bridge and requires Node on `PATH`. Same for any other
stdio-only client.

Copy from Settings rather than from here: those blocks carry your real port and
token.

---

## What it can do

One line per family; the detail is in [mcp-tools.md](./mcp-tools.md).

| Family | |
|---|---|
| **Projects** | List projects and the papers in one, with that project's own interpretation of each. |
| **Finding papers** | Word search with filters and facets, meaning-based passage search, saved searches, and `search_web` for papers you do *not* have. |
| **One paper** | Resolve a DOI/title to a `work_id`, then its metadata, documents, citations, analyses, unresolved references and citation contexts. |
| **Citation graph** | The graph around a paper, a reference tree, and fetching real metadata for unresolved references. |
| **Extraction schemas** | The schemas that define what gets extracted, their coverage, the extracted rows, and running an extraction. |
| **Review** | The queue of facts awaiting a human verdict, and recording one. |
| **Ranking** | Relevance and expansion-priority scores, inclusion decisions, manual overrides, recompute. |
| **Dossier** | Mark papers as references, build the project synthesis, read its status and entries. |
| **Queue and jobs** | What is running, retry, cancel, dismiss, pause/resume, and which papers are stale. |
| **Export and outlets** | What an export or an outlet would produce, previewing a note, and running an outlet action. |
| **Install status** | `health`, model status, integration status, storage usage. |

**Importing new papers is not a tool.** Neither is creating a project, nor
creating or editing a schema and its fields — those are decisions a person makes
in the app. (Deleting a schema or a field *is* a tool, at the delete level.)
`mcp-tools.md` lists everything deliberately excluded, and why.

---

## Working with it (for an agent)

### Conventions

- Inputs are `camelCase`; outputs are `snake_case` (the database's own names).
  Do not rename them between calls — one tool's output feeds another's input.
- Paper tools take a numeric `workId`. If you have a DOI, an arXiv id, a URL or a
  title, call `paper_resolve` first and read its `state`: only `resolved` carries
  a `work_id`. A title matching two papers returns `ambiguous` rather than
  guessing.
- **`projectId: 0` is not a project.** It is the sentinel for analyses that belong
  to no project. To search unscoped, OMIT `projectId` — passing 0 matches nothing.
- `relevance` and `expansion_priority` measure different things. Never average or
  combine them.
- A paper is stored once; its relevance, inclusion and notes are per project.
  Never pool those across projects.

### What comes back

Lists arrive as:

```json
{ "items": [], "total": 0, "limit": 200, "offset": 0, "scope_note": "…" }
```

`total` is a true `COUNT(*)`, not `items.length`. **When a result is empty, read
`scope_note`** — it says whether the install is empty, the project is empty, or
your filters excluded everything. A fresh install is legitimately empty; call
`health` before reporting an absence of evidence.

`no-source`, `no-dossier`, `no-text` and a non-null semantic `error` are **states,
not failures**. They describe what the app knows.

Named DTOs (`WorkDetailDTO`, `RerunResultDTO`, …) have their fields listed per
tool in [mcp-tools.md](./mcp-tools.md).

**Errors.** An ordinary failure — a bad argument, a missing row — comes back as a
normal result with `isError: true` and a readable message; act on it, do not
retry blindly. Only two things are thrown as protocol errors: calling a tool
above the permission level or one that does not exist (`MethodNotFound`), and
the server being too busy (retry after the number of seconds it names). Absolute
file paths are stripped out of every response, so a missing path is redaction,
not absence.

### Limits you will hit

- **Arguments are capped** before a tool runs: `limit` ≤ 200, semantic `k` ≤ 50,
  graph nodes ≤ 300, unresolved references per paper in a reference tree ≤ 5.
  Asking for more silently gets you the cap.
- **Responses are capped at 4 MiB.** A list is cut at a row boundary and flagged
  `truncated: true`; something that is not a list is refused instead of returned
  broken. Narrow with `limit`/`offset` or filters.
- **Some tools return a job, not a result.** `paper_reprocess`,
  `paper_stage_rerun`, `references_retrieve`, `job_retry` and `job_cancel` queue
  work and return immediately — poll `job_get` or `jobs_list` for the outcome.
  `paper_extract_run`, `paper_summary_generate` and `dossier_build` are the
  opposite: slow, but they return when the work is done and there is nothing to
  poll. Each tool's own description says which it is; believe it over this list.
- **A write is not rolled back** if your call times out or the connection drops.
  Read the state back before retrying anything that mutates.
- **Concurrency**: 3 calls at a time, of which at most 1 may be a tool marked
  *long-running* in the reference. Beyond that calls queue; with 32 already
  waiting they are refused with "The app is busy with other agent calls." One
  call may run for at most 10 minutes.
- Pausing the queue means "claim no new work". A running job is not aborted, so
  `inFlight` can stay above 0 after a successful pause.

---

## Troubleshooting

**Status says `Failed` and the port is highlighted.** Something else holds that
port. Type a different one in **Port**. A start you asked for looks up to 8 ports
forward for a free one; a start at app launch does not, so a second copy of the
app fails here rather than quietly serving your corpus on a port nobody was told
about. A port found that way is used for this session only and never saved — recopy
the config block, since the URL may have moved.

**401 Unauthorized.** In order of likelihood: the token in your client is stale
(regenerating rewrites it — recopy the block); the header is malformed (it must be
exactly `Authorization: Bearer <token>`); your client sends an `Origin` header
(browser-based clients are refused by design); or you reached the server under a
hostname it does not answer to. All four return the same blank 401 — the audit log
records which it actually was.

**404.** Right server, wrong path. The endpoint is `/mcp`.

**405.** The transport is POST-only; a client opening a GET event stream gets this.

**429.** More than 10 refused requests in a minute from the same caller blocks it
for five minutes, or you exceeded 300 requests a minute overall.

**Can't reach it from another machine.** Tick *accept connections from other
machines*, apply the restart, and use one of the LAN addresses listed in Settings
— the config block always names `127.0.0.1`, which means "this machine" and will
not work from a second one. Then check the port is open in your firewall. It is
unencrypted; see [Security](#security).

**Connected, but the tools I want are missing.** The permission level is too low.
Read-only exposes 46 tools; the count for the current level is in Settings and in
`health`. Raise it with the two checkboxes under **Advanced**.

**The app is quitting and my writes are refused.** Once a quit is under way,
writes are refused with a message saying nothing was written. Reads keep working
until the process goes.
