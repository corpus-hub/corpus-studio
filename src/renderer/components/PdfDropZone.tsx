import { useState } from 'react'

/**
 * "Import from file" — the one surface for getting PDFs off this computer.
 *
 * Dropping, browsing for files and browsing for a folder are the same job, so
 * they live in one bordered region rather than a drop zone plus a stray button.
 * Folders need their own dialog mode — a single native picker cannot offer both
 * files and directories on Linux or Windows — which is why there are two
 * buttons behind one region and not one.
 *
 * SHARED between the Papers screen and the setup questionnaire. Both are asking
 * for exactly this, and a second copy would drift from this one the first time
 * either was fixed. The component owns only its drag state; queueing is the
 * caller's, because the two differ in what happens next — Papers follows the
 * work to the queue tab, setup keeps the reader on the form.
 */
export function PdfDropZone({
  busy,
  onFiles,
  onPick,
  compact = false
}: {
  /** Queueing is in flight. The buttons refuse rather than stacking imports. */
  busy: boolean
  /** Files dropped. Directories arrive too and are expanded by the caller. */
  onFiles: (files: File[]) => void
  /** Open the native picker. Must go through main: see the caller's note. */
  onPick: () => void
  /** Tighter, for a section of a longer form rather than a screen of its own. */
  compact?: boolean
}): JSX.Element {
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className={`ing-drop ${dragOver ? 'is-over' : ''} ${busy ? 'is-busy' : ''} ${
        compact ? 'is-compact' : ''
      }`}
      data-testid="ingest-drop"
      onDragEnter={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragOver={(e) => {
        // Must fire on EVERY dragover, not just the first: without it the drop
        // never reaches this handler and the window navigates to the file.
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      // Guarded on the drag leaving the REGION, not a child: crossing the icon
      // or the button fires a leave, which dropped the highlight mid-drag.
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        onFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <svg
        className="ing-drop-icon"
        width="26"
        height="26"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path d="M10 13V3.5M6.5 7L10 3.5 13.5 7" />
        <path d="M3.5 12.5V15A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5v-2.5" />
      </svg>
      <span className="ing-drop-title">
        {dragOver ? 'Release to add' : 'Drop PDFs or folders here'}
      </span>
      <div className="ing-drop-actions">
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="ingest-pick-file"
          disabled={busy}
          data-tip={busy ? 'Still adding the last files.' : undefined}
          onClick={onPick}
        >
          Choose file or folder
        </button>
      </div>
    </div>
  )
}
