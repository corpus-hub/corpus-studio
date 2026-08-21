import { useEffect, useState } from 'react'

/**
 * A clock that re-renders the caller on a fixed cadence.
 *
 * Elapsed times are computed from `Date.now()` at render, so without a ticker
 * every "2 minutes ago" would freeze at the value it had when the list was
 * fetched and quietly go stale while the user watched it.
 *
 * `periodMs = 0` disables the timer entirely, for a list with nothing live in
 * it — an interval that only ever recomputes the same string is wasted work.
 */
export function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (periodMs <= 0) return
    const h = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(h)
  }, [periodMs])
  return now
}

/**
 * Parse a stored timestamp to epoch ms, or null when there is nothing to parse.
 *
 * SQLite holds these as TEXT. A row written before a column existed is null,
 * and a malformed value is treated the same way: callers must say "not
 * recorded" rather than render an Invalid Date or a zero.
 */
export function parseStamp(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

/**
 * `H:MM:SS` for spans of an hour or more, `MM:SS` below that, and `0.04s` under
 * a second.
 *
 * The sub-second case is not cosmetic. A cache hit finishes in tens of
 * milliseconds, and rounding that to whole seconds renders
 * `00:00` — which reads as "this was never timed", indistinguishable from the
 * state where the stamps genuinely are missing. A job that took 40 ms did take
 * 40 ms, and the display must not be the thing that discards it.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${(Math.max(0, ms) / 1000).toFixed(2)}s`
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * "just now" / "4 min ago" / "3 days ago".
 *
 * Coarsens as it goes: a paper added last March does not become more
 * informative for being described to the second.
 */
export function formatRelative(fromMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - fromMs)
  const sec = Math.round(d / 1000)
  if (sec < 10) return 'just now'
  if (sec < 60) return `${sec} sec ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`
  const mon = Math.round(day / 30)
  if (mon < 12) return `${mon} month${mon === 1 ? '' : 's'} ago`
  const yr = Math.round(mon / 12)
  return `${yr} year${yr === 1 ? '' : 's'} ago`
}
