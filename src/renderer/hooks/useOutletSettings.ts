import { useCallback, useEffect, useState } from 'react'
import type { OutletSettingsDTO } from '@shared/contract'

/**
 * The outlets' persisted settings, with an optimistic patch that ROLLS BACK.
 *
 * A switch must move the instant it is clicked — waiting for a disk round-trip
 * makes it feel broken. But an optimistic update that is not reverted on failure
 * is worse than no optimism at all: the switch would sit in a position the
 * database does not hold, which is exactly the lie this screen was rewritten to
 * remove. So the previous value is captured, applied immediately, and restored
 * if main rejects — with the reason surfaced.
 *
 * Main returns the FULL new state from every write, so the settled value comes
 * from the write itself rather than a re-read that could race another change.
 */
export interface OutletSettingsState {
  settings: OutletSettingsDTO | null
  loading: boolean
  error: string | null
  /** In-flight key, for disabling just the control being changed. */
  pending: string | null
  patch: (outlet: 'zotero' | 'obsidian', delta: Record<string, unknown>) => Promise<boolean>
  reload: () => void
}

export function useOutletSettings(): OutletSettingsState {
  const [settings, setSettings] = useState<OutletSettingsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .getOutletSettings()
      .then((s) => {
        if (!cancelled) {
          setSettings(s)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const patch = useCallback(
    async (outlet: 'zotero' | 'obsidian', delta: Record<string, unknown>): Promise<boolean> => {
      const key = `${outlet}.${Object.keys(delta).join(',')}`
      setPending(key)
      setError(null)
      // Captured BEFORE the optimistic write, so a rejection can restore exactly
      // what was there rather than an approximation of it.
      const previous = settings
      if (previous) {
        setSettings({ ...previous, [outlet]: { ...previous[outlet], ...delta } })
      }
      try {
        setSettings(await window.api.updateOutletSettings(outlet, delta))
        return true
      } catch (e) {
        if (previous) setSettings(previous)
        setError(e instanceof Error ? e.message : String(e))
        return false
      } finally {
        setPending(null)
      }
    },
    [settings]
  )

  return {
    settings,
    loading,
    error,
    pending,
    patch,
    reload: () => setNonce((n) => n + 1)
  }
}
