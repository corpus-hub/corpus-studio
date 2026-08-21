import { useMemo, useRef, useState } from 'react'
import type { LicenceEntryDTO, LicenceTextDTO } from '@shared/contract'
import { Modal } from './ui'
import { useAsync } from '../lib/useAsync'

// About → Third-party licences. Apache-2.0 §4 requires attribution and this app
// bundles five Apache-2.0 payloads (qpdf, eng.traineddata, arctic-embed-s,
// ms-marco-MiniLM-L-6-v2, sqlite-vec) on top of its npm closure, so this screen
// is a compliance obligation, not a nicety.
//
// It holds NO list of its own: `window.api.listLicences()` serves a GENERATED
// manifest (scripts/gen-licences.ts, verified current by `npm run
// verify:licences`), so the screen cannot drift from what is actually shipped.
// Full texts are fetched per entry on expand — ~400 KB in total, which has no
// business in the bundle for something most readers never open. Nothing is ever
// fetched over the network.

/** One expandable component row. Its full text loads only when it is opened. */
function LicenceRow({ entry }: { entry: LicenceEntryDTO }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<LicenceTextDTO | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // 'copied' is a transient acknowledgement; the timer is cleared on re-copy so
  // rapid clicks cannot leave the label stuck.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (!next || text || loading) return
    setLoading(true)
    setFailed(null)
    try {
      setText(await window.api.getLicenceText(entry.id))
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const copy = async (): Promise<void> => {
    if (!text?.text) return
    await navigator.clipboard.writeText(text.text)
    setCopied(true)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className={`lic-row ${open ? 'is-open' : ''}`} data-testid={`lic-row-${entry.id}`}>
      <button
        type="button"
        className="lic-head"
        aria-expanded={open}
        data-testid={`lic-toggle-${entry.id}`}
        onClick={() => void toggle()}
      >
        <span className={`lic-caret ${open ? 'open' : ''}`} aria-hidden="true">
          ▶
        </span>
        <span className="lic-name">{entry.name}</span>
        <span className="lic-version mono">{entry.version}</span>
        {/* The SPDX id is the load-bearing fact, so it is a bordered pill and
            not a bare colour: a licence distinguished only by hue is unreadable
            to a colourblind reader and invisible in a screenshot. */}
        <span className={`lic-spdx mono ${entry.kind === 'payload' ? 'is-payload' : ''}`}>
          {entry.license}
        </span>
      </button>
      {open && (
        <div className="lic-body">
          {entry.purpose && <p className="lic-purpose">{entry.purpose}</p>}
          {entry.homepage && <p className="lic-home mono">{entry.homepage}</p>}
          {loading ? (
            // Busy is a first-class state, not the same pane with different
            // words: without a moving signal a slow read is indistinguishable
            // from a finished one that found nothing.
            <div className="lic-note is-busy mono" data-testid={`lic-loading-${entry.id}`}>
              <span className="lic-spin" aria-hidden="true" />
              Reading licence text…
            </div>
          ) : failed ? (
            <div className="lic-note is-failed mono" data-testid={`lic-failed-${entry.id}`}>
              Could not read the licence text: {failed}
            </div>
          ) : text?.text ? (
            <>
              <div className="lic-actions">
                <button
                  type="button"
                  className={`btn btn-secondary lic-copy ${copied ? 'is-copied' : ''}`}
                  data-testid={`lic-copy-${entry.id}`}
                  onClick={() => void copy()}
                >
                  {copied ? '✓ Copied' : 'Copy text'}
                </button>
              </div>
              <pre className="lic-text mono" data-testid={`lic-text-${entry.id}`}>
                {text.text}
              </pre>
            </>
          ) : (
            // Never blank. "This package ships no LICENSE file" is a fact about
            // upstream; an empty pane reads as a bug in this screen.
            <div className="lic-note mono" data-testid={`lic-none-${entry.id}`}>
              {text?.note ?? 'No licence text available.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function LicencesModal({ onClose }: { onClose: () => void }): JSX.Element {
  const list = useAsync<LicenceEntryDTO[]>(() => window.api.listLicences(), [])
  const [query, setQuery] = useState('')
  const entries = list.data ?? []

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) => e.name.toLowerCase().includes(q) || e.license.toLowerCase().includes(q)
    )
  }, [entries, query])

  const payloads = shown.filter((e) => e.kind === 'payload')
  const packages = shown.filter((e) => e.kind === 'npm')

  return (
    <Modal title="Third-party licences" onClose={onClose} testid="licences-modal">
      <div className="settings-sub mono" data-testid="lic-count">
        {list.loading
          ? 'Reading attribution…'
          : `${entries.length} component${entries.length === 1 ? '' : 's'} · bundled in this build · nothing is fetched`}
      </div>

      {list.error ? (
        <div className="lic-note is-failed mono" data-testid="lic-error">
          Could not read the attribution list: {list.error}
        </div>
      ) : (
        <>
          <input
            className="lic-filter"
            type="search"
            placeholder="Filter by name or licence…"
            aria-label="Filter third-party components"
            data-testid="lic-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {shown.length === 0 && !list.loading ? (
            <div className="lic-note is-empty mono" data-testid="lic-empty">
              Nothing matches “{query}”. All {entries.length} components are still listed — clear
              the filter to see them.
            </div>
          ) : (
            <>
              {payloads.length > 0 && (
                <div className="settings-section">
                  <div className="settings-eyebrow mono">
                    Bundled binaries &amp; models · {payloads.length}
                  </div>
                  <div className="lic-list">
                    {payloads.map((e) => (
                      <LicenceRow key={e.id} entry={e} />
                    ))}
                  </div>
                </div>
              )}
              {packages.length > 0 && (
                <div className="settings-section">
                  <div className="settings-eyebrow mono">
                    Software packages · {packages.length}
                  </div>
                  <div className="lic-list">
                    {packages.map((e) => (
                      <LicenceRow key={e.id} entry={e} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}
