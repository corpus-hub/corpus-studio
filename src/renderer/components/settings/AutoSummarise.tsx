import { useEffect, useState, type JSX } from 'react'
import { SwitchField } from '../ui'

/**
 * Whether importing a paper into this project summarises it, unasked.
 *
 * IN SETTINGS → AI, beside the briefs that say HOW a paper is summarised, because
 * this is the switch that says WHETHER it is. It first shipped on the Project
 * context screen, next to the list of summaries it governs — which sounded
 * reasonable and was wrong: nobody looks for a setting inside a briefing, and a
 * setting nobody can find is one that does not exist.
 *
 * PER PROJECT, so it is offered only when a project is open — the same rule the
 * project brief below it follows. At the library level there is no project to
 * answer for and the switch is simply absent.
 *
 * OPTIMISTIC, reverting on a refused write. The switch is the only thing on
 * screen reporting this setting, so holding the old value until a round trip
 * finishes makes a press look ignored — while keeping the NEW value after a
 * failure would misstate what the pipeline is about to do.
 */
export function AutoSummarise({
  projectId,
  projectName
}: {
  projectId: number
  projectName: string
}): JSX.Element | null {
  const [on, setOn] = useState<boolean | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.getProject(projectId).then((p) => {
      if (alive) setOn(p?.auto_summarise ?? true)
    })
    return () => {
      alive = false
    }
  }, [projectId])

  // Nothing is drawn until the answer arrives. A switch rendered "off" and then
  // flicking on states something false about the project, however briefly.
  if (on === null) return null

  const toggle = (next: boolean): void => {
    setOn(next)
    setFailed(null)
    void window.api.updateProjectSetup({ projectId, autoSummarise: next }).catch((e: unknown) => {
      setOn(!next)
      setFailed(
        `That was not saved, so the setting is unchanged. ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    })
  }

  return (
    <div className="settings-section">
      <div className="settings-eyebrow mono">Whether papers are summarised at all</div>
      <SwitchField
        label={`Summarise new papers in ${projectName}`}
        on={on}
        onWord="Automatically"
        offWord="Only when asked"
        tip={
          on
            ? 'Every paper imported into this project is summarised as it arrives. Switch off to import without calling a model.'
            : 'Imported papers are not summarised. The step shows as turned off in the queue on the Papers screen, where you can run it for one paper at a time. Switching this back on does not summarise papers already imported.'
        }
        testid="settings-auto-summarise"
        onToggle={toggle}
      />
      {/* Says where the work goes instead, because a switch that only stops
          something leaves the reader asking how to get it when they do want it. */}
      <p className="settings-pref-help">
        {on
          ? 'Turn this off to import papers without calling a model. You can still summarise any single paper by hand.'
          : 'Papers arrive without summaries. To summarise one, open Papers → Queue, expand its row and press Run on the summary step. Turning this back on does not summarise papers already imported.'}
      </p>
      {failed !== null && (
        <p className="form-error" role="alert" data-testid="settings-auto-summarise-failed">
          {failed}
        </p>
      )}
    </div>
  )
}
