import type { McpFailure } from '@shared/contract'

/**
 * Session counters and the last-error slot.
 *
 * READS NO DB, on purpose: the Settings pane polls the status every 2s while the
 * server is not stopped, and better-sqlite3 is synchronous on the main thread —
 * a status that touched the DB would make an idle Settings pane a source of UI
 * jank.
 */

let calls = 0
let lastConnectedAt: string | null = null
let lastToolCalled: string | null = null
let lastError: McpFailure | null = null

export function noteCall(tool: string): void {
  calls++
  lastConnectedAt = new Date().toISOString()
  lastToolCalled = tool
}

/**
 * Record a failure, as an ENUM member.
 *
 * Deliberately not a message: this value is polled into the renderer every 2s,
 * and free text assembled anywhere near a request is how a token ends up in a
 * payload that frequent. Anything the user needs beyond the category is in the
 * audit log, which does not cross into the renderer.
 */
export function noteFailure(kind: McpFailure): void {
  lastError = kind
}

export function clearFailure(): void {
  lastError = null
}

export function resetSession(): void {
  calls = 0
  lastConnectedAt = null
  lastToolCalled = null
  lastError = null
}

export function sessionCounters(): {
  callsThisSession: number
  lastConnectedAt: string | null
  lastToolCalled: string | null
  lastError: McpFailure | null
} {
  return { callsThisSession: calls, lastConnectedAt, lastToolCalled, lastError }
}
