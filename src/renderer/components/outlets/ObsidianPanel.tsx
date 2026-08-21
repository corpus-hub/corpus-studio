import { useEffect, useState } from 'react'
import type { OutletActionDTO, OutletSettingsDTO, OutletStatusDTO } from '@shared/contract'
import { OutletCard, ToggleRow } from './OutletCard'
import { OutletActions } from './OutletActions'

/**
 * Obsidian: mirror this project's analyses into a vault as markdown.
 *
 * Every control here is real. The vault path comes from a native folder picker
 * and is stored; every switch persists; and "Write notes" writes files and
 * reports the paths. The markdown preview is rendered by the SAME function that
 * writes the file (`@shared/markdown` via `previewOutletNote`), so what is shown
 * is what would be written — not a mock-up of it.
 */
export function ObsidianPanel({
  projectId,
  status,
  settings,
  pending,
  onPatch,
  onChanged
}: {
  projectId: number
  status: OutletStatusDTO
  settings: OutletSettingsDTO['obsidian']
  pending: string | null
  onPatch: (delta: Record<string, unknown>) => Promise<boolean>
  onChanged: () => void
}): JSX.Element {
  const [actions, setActions] = useState<OutletActionDTO[]>([])
  const [preview, setPreview] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState(settings.folder)

  // Follow the persisted value when it changes underneath us (a rejected write
  // rolls back, and the draft must roll back with it rather than keep showing a
  // folder the database does not hold).
  useEffect(() => setFolderDraft(settings.folder), [settings.folder])

  const commitFolder = async (): Promise<void> => {
    const next = folderDraft.trim()
    if (next === settings.folder) return
    // An empty box means the vault root, which is a legitimate choice; the
    // placeholder shows the default rather than the field rejecting emptiness.
    if (!(await onPatch({ folder: next.length > 0 ? next : 'Corpus Studio' }))) {
      setFolderDraft(settings.folder)
    }
  }

  useEffect(() => {
    void window.api.listOutletActions(projectId, 'obsidian').then(setActions)
  }, [projectId, status.ready, settings.vault_path, settings.backlinks])

  // The preview follows the settings that change it, so toggling backlinks shows
  // the difference immediately rather than after the next write.
  useEffect(() => {
    let cancelled = false
    void window.api
      .listProjectWorks(projectId)
      .then((works) =>
        works.length > 0 ? window.api.previewOutletNote(projectId, works[0].work.id) : null
      )
      .then((md) => {
        if (!cancelled) setPreview(md)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, settings.backlinks])

  const chooseVault = async (): Promise<void> => {
    const picked = await window.api.pickDirectory()
    // A dismissed chooser is not an error and not an empty path — nothing changes.
    if (picked === null) return
    await onPatch({ vault_path: picked })
  }

  return (
    <OutletCard
      status={status}
      pill="Outlet"
      avatar={
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M8 2.5l6 4.5-2 9-6-2-2-7z" />
        </svg>
      }
    >
      <div className="int-fields">
        <div className="int-field">
          <div className="int-section-label">Vault folder</div>
          <div className="int-field-row">
            <span
              className="mono int-field-val"
              data-tip={settings.vault_path ?? undefined}
              data-testid="obsidian-vault-path"
            >
              {settings.vault_path ?? 'No folder chosen'}
            </span>
            <button
              type="button"
              className="btn btn-secondary int-btn-sm"
              data-testid="obsidian-pick-vault"
              disabled={pending !== null}
              onClick={() => void chooseVault()}
            >
              {settings.vault_path ? 'Change…' : 'Choose…'}
            </button>
          </div>
        </div>
        <div className="int-field">
          <div className="int-section-label">Notes go in</div>
          {/* Editable: a user who wants notes in `Literature/` or at the vault
              root could otherwise not say so, though the path resolver has
              always supported it. Committed on blur or Enter rather than per
              keystroke, so a half-typed folder name is never persisted. */}
          <input
            className="stor-input int-folder-input"
            data-testid="obsidian-folder"
            value={folderDraft}
            disabled={pending !== null}
            placeholder="Corpus Studio"
            aria-label="Folder within the vault that notes are written to"
            onChange={(e) => setFolderDraft(e.target.value)}
            onBlur={() => void commitFolder()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitFolder()
              if (e.key === 'Escape') setFolderDraft(settings.folder)
            }}
          />
          {folderDraft.trim() !== settings.folder && (
            <div className="int-folder-warn" role="note">
              Notes already written to <strong>{settings.folder}</strong> stay there. Use
              &ldquo;Remove notes for deleted papers&rdquo; afterwards to tidy them up.
            </div>
          )}
        </div>
      </div>

      <ToggleRow
        title="Link cited works"
        sub="[[wiki links]] between papers that cite each other"
        on={settings.backlinks}
        busy={pending === 'obsidian.backlinks'}
        onToggle={(next) => void onPatch({ backlinks: next })}
        testid="obsidian-toggle-backlinks"
      />
      <ToggleRow
        title="Mirror automatically"
        sub="Rewrite a note whenever its analysis is regenerated"
        on={settings.auto_mirror}
        busy={pending === 'obsidian.auto_mirror'}
        onToggle={(next) => void onPatch({ auto_mirror: next })}
        testid="obsidian-toggle-auto"
      />

      <OutletActions
        projectId={projectId}
        outletId="obsidian"
        actions={actions}
        onDone={onChanged}
      />

      <div className="int-preview">
        <div className="int-preview-head">
          <span className="int-section-label int-preview-label">Note preview</span>
          <span className="mono int-preview-file">exactly what gets written</span>
        </div>
        {preview ? (
          <pre className="mono int-md-preview" data-testid="obsidian-preview">
            {preview.length > 900 ? `${preview.slice(0, 900)}\n…` : preview}
          </pre>
        ) : (
          <div className="int-preview-empty">
            No papers in this project yet — a note appears here once one is added.
          </div>
        )}
      </div>
    </OutletCard>
  )
}
