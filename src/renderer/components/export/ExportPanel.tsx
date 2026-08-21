import { useState } from 'react'
import type { ExportOptionDTO } from '@shared/contract'
import { useAsync } from '../../lib/useAsync'
import { DataView, EmptyState } from '../States'
import { fmtBytes } from '../../lib/format'

/**
 * Every way this project's data can leave the app, as a file.
 *
 * This component NAMES NO FORMAT. The buttons come from
 * `window.api.listExportOptions(projectId)`, which main derives from the export
 * registry plus the project's own attached extraction schemas. That is the point
 * of the indirection: a particular domain's interchange format used to be a
 * hardcoded third button here, which made one field's convention look like a
 * built-in capability of a domain-agnostic app. Now a project that attaches
 * three schemas simply offers three table exports, and this file never learns
 * their names.
 *
 * The status line is a small state machine whose phases are deliberately NOT
 * collapsible: a dismissed dialog is `canceled`, not `done`, so no dismissal can
 * ever render as a success, and a failure carries the reason rather than a badge.
 */
type Phase =
  | { phase: 'idle' }
  | { phase: 'running'; label: string }
  | { phase: 'done'; label: string; bytes: number; path: string | null; exportId: string | null }
  | { phase: 'canceled'; label: string }
  | { phase: 'error'; label: string; message: string }

export function ExportPanel({ projectId }: { projectId: number }): JSX.Element {
  const options = useAsync<ExportOptionDTO[]>(
    () => window.api.listExportOptions(projectId),
    [projectId]
  )
  // Every export is built FROM the project's papers, so with none there is
  // nothing any of these buttons could put in a file. Letting one run wrote a
  // valid, empty document to a path the user chose — a successful-looking export
  // of nothing, which is worse than being told why it is off.
  const project = useAsync(() => window.api.getProject(projectId), [projectId])
  const noPapers = project.data != null && project.data.work_count === 0
  const [state, setState] = useState<Phase>({ phase: 'idle' })
  const [revealFailed, setRevealFailed] = useState(false)

  const run = async (option: ExportOptionDTO): Promise<void> => {
    setRevealFailed(false)
    setState({ phase: 'running', label: option.label })
    try {
      const res = await window.api.exportProjectToFile(projectId, option.id)
      if (res.canceled) {
        setState({ phase: 'canceled', label: option.label })
        return
      }
      setState({
        phase: 'done',
        label: option.label,
        bytes: res.bytes,
        path: res.path,
        exportId: res.export_id
      })
    } catch (e) {
      // Main unlinks its temp file before throwing, so there is genuinely no
      // file at the chosen path to mislead the user about.
      setState({
        phase: 'error',
        label: option.label,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  const busy = state.phase === 'running'

  return (
    <section className="card int-export-card" data-testid="export-panel">
      <div className="int-export">
        <div className="int-export-copy">
          Pick what to take with you, and the format to take it in. Each one builds from the
          database and asks where to save it.
        </div>

        <DataView
          state={options}
          isEmpty={(o) => o.length === 0}
          skeleton={<div className="sk" style={{ height: 64 }} />}
          empty={
            <EmptyState
              title="Nothing to export yet."
              hint="Exports are built from this project's papers and the extraction schemas attached to it."
            />
          }
        >
          {(list) => {
            // One row per THING, with its formats beside it. A flat list of
            // buttons repeated a long schema name once per format ("Protein
            // Thermostability Characterization · XLSX" then "· CSV"), which read
            // as two unrelated exports and wrapped badly. The user is choosing
            // what to export first and in which format second, so the layout
            // says that.
            const groups: Array<{ name: string; description: string; options: ExportOptionDTO[] }> =
              []
            for (const o of list) {
              const existing = groups.find((g) => g.name === o.group)
              if (existing) existing.options.push(o)
              else groups.push({ name: o.group, description: o.description, options: [o] })
            }
            return (
              <div className="export-groups">
                {groups.map((g) => (
                  <div className="export-group" key={g.name}>
                    <div className="export-group-formats">
                      {g.options.map((o) => (
                        <button
                          key={o.id}
                          type="button"
                          className="btn btn-secondary export-option"
                          data-testid={`export-${o.id}`}
                          disabled={busy || noPapers}
                          aria-label={o.label}
                          data-tip={
                            noPapers
                              ? 'This project has no papers yet, so this export would be empty.'
                              : busy
                                ? 'Another export is being built…'
                                : o.description
                          }
                          onClick={() => void run(o)}
                        >
                          {o.format}
                        </button>
                      ))}
                    </div>
                    <div className="export-group-copy">
                      <div className="export-group-name">{g.name}</div>
                      <div className="export-group-desc">{g.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            )
          }}
        </DataView>

        <div className="int-export-status" role="status" aria-live="polite">
          {state.phase !== 'idle' && (
            <div className="mono export-msg" data-testid="export-msg">
              {state.phase === 'running' && (
                <>
                  <span className="badge badge-muted">working</span> Building {state.label} — choose
                  where to save it…
                </>
              )}
              {state.phase === 'done' && (
                <>
                  <span className="badge badge-ok">saved</span> {state.label} ·{' '}
                  {fmtBytes(state.bytes)} written to{' '}
                  <span className="int-export-path" data-tip={state.path ?? undefined}>
                    {state.path}
                  </span>
                  {state.exportId && (
                    <button
                      type="button"
                      className="btn-link int-export-reveal"
                      data-testid="export-reveal"
                      onClick={() => {
                        const id = state.exportId as string
                        // Main returns false if the file is no longer there
                        // (moved or deleted since). Say so rather than leaving a
                        // button that silently does nothing.
                        void window.api.revealExport(id).then((shown) => {
                          if (!shown) setRevealFailed(true)
                        })
                      }}
                    >
                      Show in folder
                    </button>
                  )}
                  {revealFailed && (
                    <span className="int-export-gone">— the file is no longer at that path</span>
                  )}
                </>
              )}
              {/* A dismissed dialog is NOT a success and must never wear the
                  'saved' badge — it gets its own neutral line. */}
              {state.phase === 'canceled' && (
                <>
                  <span className="badge badge-muted">cancelled</span> {state.label} cancelled — no
                  file was written.
                </>
              )}
              {state.phase === 'error' && (
                <>
                  <span className="badge badge-danger">failed</span> {state.label} failed —{' '}
                  {state.message}. No file was saved.
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
