import { useEffect, useState } from 'react'
import type { GatewayConfigDTO, StorageProjectDTO } from '@shared/contract'
import { Modal } from './ui'
import { useAsync } from '../lib/useAsync'
import { fmtBytes } from '../lib/format'
import { StorageLocations } from './settings/StorageLocations'
import { ReadingPrefs } from './settings/ReadingPrefs'
import { Updates } from './settings/Updates'
import { DeveloperLog } from './settings/DeveloperLog'
import { McpServer } from './settings/McpServer'
import { QueueLimits } from './settings/QueueLimits'
import { ModelChoice } from './settings/ModelChoice'
import { SummaryPromptEditor } from './settings/SummaryPrompt'
import { Plugins } from './settings/Plugins'
import { SettingsTransfer } from './settings/SettingsTransfer'
import { TokenUsageChart } from './settings/TokenUsageChart'
import { RichText } from './RichText'

// Settings, as tabs behind an icon rail.
//
// One scrolling column would ask the reader to scroll past several unrelated
// subjects to reach the one they came for, so each subject gets its own pane.
//
// Model and MCP are separate tabs because they point in opposite directions:
// Model is OUTBOUND (which model this app calls), MCP is INBOUND (which agents
// call this app). They are two subjects, not two halves of one.
//
// The rail is icons with labels — icon-only would make the reader learn five
// glyphs to find a setting they visit twice a year.

type TabKey = 'general' | 'ai' | 'queue' | 'analytics' | 'mcp' | 'plugins' | 'storage' | 'about'

/**
 * The tabs, as data, so the rail and the panes cannot disagree about which
 * exist or what they are called.
 */
const TABS: Array<{ key: TabKey; label: string; icon: JSX.Element }> = [
  {
    key: 'general',
    label: 'General',
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="10" cy="10" r="2.6" />
        <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
      </svg>
    )
  },
  {
    // "AI", not "Model": this pane configures WHERE the app sends its
    // requests — an endpoint and a key. Which model answers is the gateway's
    // decision, so naming the tab after a thing the user cannot choose here
    // promised a control that does not exist.
    key: 'ai',
    label: 'AI',
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
        <circle cx="10" cy="10" r="2.4" />
        <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2" />
      </svg>
    )
  },
  {
    // Directly after AI, because its main setting is about AI work and the two
    // are read together: "where requests go" and "how many at a time".
    key: 'queue',
    label: 'Queue',
    // Stacked bars of decreasing length — a line of work waiting its turn.
    // Readable as neither the AI chip nor the MCP bracket.
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M3.5 5.5h13M3.5 10h9M3.5 14.5h5" />
      </svg>
    )
  },
  {
    // After Queue, because it reports on the work the queue does and the two
    // are read together: "how much runs at a time" and "what that has cost".
    key: 'analytics',
    label: 'Analytics',
    // A rising line over an axis. Readable as neither the queue's flat stacked
    // bars above it nor the AI chip — the one glyph in the rail that goes UP.
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M3 16.5V3.5" strokeLinecap="round" />
        <path d="M3 16.5h14" strokeLinecap="round" />
        <path d="m5.5 13 3.5-4 3 2.5 4.5-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    key: 'mcp',
    label: 'MCP',
    // An arrow entering a bracket: this tab is the INBOUND direction, and its
    // glyph has to be readable as the opposite of the Model tab's chip beside
    // it rather than as another variation on it.
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M13 3.5h2.5a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H13" strokeLinecap="round" />
        <path d="M2.5 10h8" strokeLinecap="round" />
        <path d="M7.6 6.9 10.7 10l-3.1 3.1" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  },
  {
    // A power outlet: a plugin is something this app plugs an outside service
    // into. Readable as neither the Model chip nor the MCP bracket beside it.
    key: 'plugins',
    label: 'Plugins',
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M7 2.5v4M13 2.5v4" strokeLinecap="round" />
        <path d="M4.5 6.5h11v3a5.5 5.5 0 0 1-11 0z" strokeLinejoin="round" />
        <path d="M10 15v2.5" strokeLinecap="round" />
      </svg>
    )
  },
  {
    key: 'storage',
    label: 'Storage',
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <ellipse cx="10" cy="5" rx="6.5" ry="2.5" />
        <path d="M3.5 5v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5" />
        <path d="M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
      </svg>
    )
  },
  {
    key: 'about',
    label: 'About',
    icon: (
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="10" cy="10" r="7" />
        <path d="M10 9v4.5" strokeLinecap="round" />
        <circle cx="10" cy="6.4" r="0.5" fill="currentColor" />
      </svg>
    )
  }
]

/**
 * The gateway the app talks to: where it is, and the key it presents.
 *
 * Replaces a radio list of models. Which model answers is the GATEWAY's
 * business — it routes to whatever it is configured for, and the app only ever
 * needs to know how to reach it.
 *
 * The key is write-only across IPC. The field shows whether one is set and
 * never what it is; `getGatewayConfig` returns a boolean, not the value.
 */
function GatewayFields(): JSX.Element {
  const [cfg, setCfg] = useState<GatewayConfigDTO | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let dead = false
    void window.api.getGatewayConfig().then((c) => {
      if (dead) return
      setCfg(c)
      setEndpoint(c.endpointIsDefault ? '' : c.endpoint)
    })
    return () => {
      dead = true
    }
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    try {
      // The key is sent ONLY when the field was typed into. An empty box means
      // "unchanged", not "clear" — otherwise opening Settings to fix a typo in
      // the endpoint would silently delete the credential.
      const next = await window.api.setGatewayConfig({
        endpoint,
        ...(key ? { key } : {})
      })
      setCfg(next)
      setKey('')
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="set-fields">
      <label className="set-field">
        <span className="set-label">Endpoint</span>
        {/* There is no default endpoint to hint at — an unset install talks to
            nothing rather than guessing at loopback. So the placeholder names
            what is MISSING, instead of showing an address the app is not
            actually using. */}
        <input
          className="input"
          data-testid="settings-endpoint"
          placeholder={cfg?.endpointIsDefault ? 'Required — no gateway is configured' : ''}
          value={endpoint}
          onChange={(e) => {
            setEndpoint(e.target.value)
            setSaved(false)
          }}
        />
      </label>

      <label className="set-field">
        {/* No origin. Where the key is stored is a filesystem path, and a
            scientist configuring an endpoint has no use for it — the dots in
            the field already say one is set. */}
        <span className="set-label">API key</span>
        <input
          className="input"
          type="password"
          data-testid="settings-api-key"
          placeholder={cfg?.hasKey ? '••••••••' : ''}
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setSaved(false)
          }}
        />
      </label>

      <div className="set-actions">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="settings-save-gateway"
          aria-disabled={saving}
          onClick={() => {
            if (!saving) void save()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="set-note set-note-ok">Saved</span>}
      </div>
    </div>
  )
}

/** Per-project disk use, expandable to the papers inside. */
function StorageUse(): JSX.Element {
  const storage = useAsync<StorageProjectDTO[]>(() => window.api.getStorageUsage(), [])
  const rows = storage.data ?? []
  const total = rows.reduce((sum, r) => sum + r.size_bytes, 0)
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">
        Usage · {fmtBytes(total)}
      </div>
      {storage.loading ? (
        <div className="settings-storage-hint mono">Reading…</div>
      ) : rows.length === 0 ? (
        <div className="settings-storage-hint mono">No stored files.</div>
      ) : (
        <div className="settings-storage-list">
          {rows.map((g) => {
            const open = expanded === g.project_id
            return (
              <div key={g.project_id} className="settings-storage-row">
                <button
                  type="button"
                  className="settings-storage-head"
                  aria-expanded={open}
                  data-testid={`settings-storage-${g.project_id}`}
                  onClick={() => setExpanded((cur) => (cur === g.project_id ? null : g.project_id))}
                >
                  <span className={`settings-caret ${open ? 'open' : ''}`}>▶</span>
                  <span className="settings-storage-name">{g.name}</span>
                  <span className="settings-storage-size mono">{fmtBytes(g.size_bytes)}</span>
                </button>
                {open && (
                  <div className="settings-storage-papers">
                    {g.papers.length === 0 ? (
                      <div className="settings-storage-hint mono">No files.</div>
                    ) : (
                      g.papers.map((pp) => (
                        <div key={pp.work_id} className="settings-storage-paper">
                          <span className="settings-storage-paper-t"><RichText text={pp.title} /></span>
                          <span className="settings-storage-paper-s mono">
                            {fmtBytes(pp.size_bytes)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function SettingsModal({
  project,
  onOpenLicences,
  onClose
}: {
  /**
   * The project whose settings these also are, when one is open.
   *
   * Null at the library level, and then the project brief is simply not offered:
   * "how papers are read against this collection" is not a question that can be
   * answered without a collection, and a picker here would make the user choose
   * one twice.
   */
  project: { id: number; name: string } | null
  onOpenLicences: () => void
  onClose: () => void
}): JSX.Element {
  const [tab, setTab] = useState<TabKey>('general')

  return (
    <Modal title="Settings" onClose={onClose} testid="settings-modal">
      <div className="set-shell">
        <nav className="set-rail" aria-label="Settings sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`set-rail-item${tab === t.key ? ' is-on' : ''}`}
              aria-current={tab === t.key ? 'page' : undefined}
              data-testid={`settings-tab-${t.key}`}
              onClick={() => setTab(t.key)}
            >
              <span className="set-rail-icon" aria-hidden="true">
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="set-pane" data-testid={`settings-pane-${tab}`}>
          {tab === 'general' && (
            <>
              <Updates />
              <ReadingPrefs />
              {/* GENERAL, and not a tab of its own: this moves settings from
                  every pane at once, so it belongs to none of them. General is
                  already where the app-wide things live, and another rail
                  entry would make the reader learn another glyph to find a
                  button they press twice in the life of an install. */}
              <SettingsTransfer />
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="settings-section">
                <div className="settings-eyebrow mono">Where this app sends its requests</div>
                <GatewayFields />
              </div>
              {/* Directly after the endpoint, because a model name means
                  nothing without knowing who is being asked for it. */}
              <ModelChoice />
              {/* The GENERAL brief only. The other summary reads a paper against
                  ONE collection, so it belongs to the project and is edited
                  there — offering it here would ask the user to write one brief
                  for every project at once. */}
              <SummaryPromptEditor
                scope="general"
                title="How papers are summarised"
                help="The instructions this app gives the model when it writes the summary of a paper on its own terms — the one every project that holds the paper reads."
                scopeWarning="Saving marks every general summary in this app as written under different instructions; they are rewritten when their papers are next processed."
              />
              {project && (
                <SummaryPromptEditor
                  scope="project"
                  projectId={project.id}
                  title={`How papers are read for ${project.name}`}
                  help="The instructions for the second summary — what a paper means for THIS collection, read against its project context. Papers in your other projects are unaffected."
                  scopeWarning={`Saving marks this project's summaries as written under different instructions; they are rewritten when their papers are next processed. Your other projects are untouched.`}
                />
              )}
            </>
          )}

          {tab === 'queue' && <QueueLimits />}

          {tab === 'analytics' && <TokenUsageChart />}

          {tab === 'mcp' && <McpServer />}

          {tab === 'plugins' && <Plugins />}

          {tab === 'storage' && (
            <>
              <StorageLocations />
              <StorageUse />
            </>
          )}

          {/* Third-party attribution is a licence obligation (Apache-2.0 §4)
              rather than a feature: it must be discoverable, not prominent. Its
              own modal, because 93 components with full texts would bury
              everything else. */}
          {tab === 'about' && (
            <>
              {/* A diagnostic, so it sits with the other things a user reaches
                  for when something is wrong — not in General, which is for
                  settings they choose once and live with. */}
              <DeveloperLog />
              <button
                type="button"
                className="btn btn-secondary"
                data-testid="settings-open-licences"
                onClick={onOpenLicences}
              >
                Third-party licences
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
