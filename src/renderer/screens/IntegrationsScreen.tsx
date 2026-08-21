import { useCallback, useEffect, useState } from 'react'
import type { OutletStatusDTO } from '@shared/contract'
import { OUTLET_SETTINGS_UNREADABLE } from '@shared/contract/outlets'
import { ZoteroPanel } from '../components/outlets/ZoteroPanel'
import { ObsidianPanel } from '../components/outlets/ObsidianPanel'
import { ExportPanel } from '../components/export/ExportPanel'
import { useOutletSettings } from '../hooks/useOutletSettings'

/**
 * INTEGRATIONS — every way this project's work leaves the app.
 *
 * Composition only. Each outlet is a module in `src/main/outlets/` registered
 * once, and this screen renders whatever the registry reports, so adding a third
 * outlet does not touch this file.
 *
 * Storage locations used to live here too. They moved to Settings: where files
 * LIVE is configuration, while an outlet is about where analyses GO.
 */
export function IntegrationsScreen({
  projectId,
  onGoToPapers
}: {
  projectId: number
  onGoToPapers: () => void
}): JSX.Element {
  const [tab, setTab] = useState<'outlets' | 'export'>('outlets')
  const [outlets, setOutlets] = useState<OutletStatusDTO[] | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const settings = useOutletSettings()

  const loadStatus = useCallback(() => {
    window.api
      .listOutlets(projectId)
      .then((list) => {
        setOutlets(list)
        setStatusError(null)
      })
      .catch((e: unknown) => setStatusError(e instanceof Error ? e.message : String(e)))
  }, [projectId])

  useEffect(loadStatus, [loadStatus])

  // A settings change can alter a status (a vault that is now set, a Zotero
  // directory that now resolves), so the checks are re-probed after every write
  // rather than left describing the previous configuration.
  const patch = useCallback(
    async (outlet: 'zotero' | 'obsidian', delta: Record<string, unknown>): Promise<boolean> => {
      const ok = await settings.patch(outlet, delta)
      if (ok) loadStatus()
      return ok
    },
    [settings, loadStatus]
  )

  const byId = (id: string): OutletStatusDTO | undefined => outlets?.find((o) => o.id === id)
  const zotero = byId('zotero')
  const obsidian = byId('obsidian')

  return (
    <div className="screen int-screen" data-testid="screen-integrations">
      {/* Two tabs, because these are two different errands. Export used to sit
          BELOW both outlet cards, which put the most commonly wanted thing on
          the screen — "give me my data as a spreadsheet" — off the bottom of the
          page, reachable only by scrolling past two panels a user may have no
          interest in. */}
      <div className="int-tabs" role="tablist" data-testid="integrations-tabs">
        {(
          [
            ['outlets', 'Integrations'],
            ['export', 'Export']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`int-tab${tab === key ? ' is-active' : ''}`}
            data-testid={`integrations-tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'outlets' ? (
        <>
          {settings.error && (
            <div className="stor-error" role="alert" data-testid="outlet-settings-error">
              {settings.error}
            </div>
          )}
          {/* A configuration that could not be READ, said before the user acts
              on the form below. The values shown for that outlet are this
              build's defaults, not their choices — a vault path they set comes
              back blank, which is indistinguishable from never having set one.
              Without this the only sign was the refusal thrown by the next
              switch they touched, i.e. after they had already believed the
              blank form. Ordinary installs render nothing here. */}
          {settings.settings?.unreadable.map((id) => {
            // NAMED from the registry's own status, never from a literal in
            // this file: this screen renders whatever the registry reports, and
            // a third outlet must not need an entry here to be nameable. Before
            // the statuses arrive the sentence stands alone rather than falling
            // back to the raw id.
            const name = byId(id)?.name
            return (
              <div
                key={id}
                className="stor-error"
                role="alert"
                data-testid={`outlet-settings-unreadable-${id}`}
              >
                {name ? `${name}: ` : ''}
                {OUTLET_SETTINGS_UNREADABLE}
              </div>
            )
          })}
          {statusError && (
            <div className="stor-error" role="alert" data-testid="outlet-status-error">
              Could not read the outlet status — {statusError}
            </div>
          )}

          <div className="int-layout" data-testid="integration-status">
            {settings.settings && zotero && (
              <ZoteroPanel
                projectId={projectId}
                status={zotero}
                settings={settings.settings.zotero}
                pending={settings.pending}
                onPatch={(delta) => patch('zotero', delta)}
                onChanged={loadStatus}
                onGoToPapers={onGoToPapers}
              />
            )}
            {settings.settings && obsidian && (
              <ObsidianPanel
                projectId={projectId}
                status={obsidian}
                settings={settings.settings.obsidian}
                pending={settings.pending}
                onPatch={(delta) => patch('obsidian', delta)}
                onChanged={loadStatus}
              />
            )}
            {(outlets === null || settings.loading) && (
              <>
                <div className="sk" style={{ height: 380 }} />
                <div className="sk" style={{ height: 380 }} />
              </>
            )}
          </div>
        </>
      ) : (
        <ExportPanel projectId={projectId} />
      )}
    </div>
  )
}
