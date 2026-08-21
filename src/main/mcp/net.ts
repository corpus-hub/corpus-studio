import { networkInterfaces, hostname } from 'node:os'
import type { Server } from 'node:http'

/** Where the socket may be reached from, and how the port is chosen. */

export const DEFAULT_PORT = 51_820
/**
 * Random draws before giving up. Bounded, not infinite: if 24 ports in the
 * ephemeral range are all refused the cause is not contention (odds beyond
 * arithmetic) but something categorical — a sandbox denying bind, a firewall —
 * and retrying forever would hang the start instead of reporting it.
 */
const SCAN_SPAN = 24

/**
 * Every non-internal IPv4 this machine answers on.
 *
 * IPv4 only, and deliberately: the config block an agent pastes carries a URL,
 * and a link-local IPv6 with a zone index (`fe80::1%wlan0`) is not a URL any
 * client will connect with. An empty list is a REAL state the Settings pane
 * renders — a machine with no network is not an error.
 */
export function lanAddresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      out.push(addr.address)
    }
  }
  return out.sort()
}

/**
 * The `Host:` values the server will answer to.
 *
 * Recomputed on EVERY bind, because a VPN coming up or a DHCP lease changing
 * makes yesterday's list wrong — and a stale allowlist does not fail loudly, it
 * refuses the user's own agent with the same blank 401 as an attacker.
 *
 * Names as well as addresses when bound to the LAN: a client told to use
 * `http://<hostname>.local:51820/mcp` sends that in `Host`, and an allowlist of
 * literal IPv4s alone would reject it.
 */
export function allowedHosts(bind: string, port: number): string[] {
  const names = ['127.0.0.1', 'localhost', '[::1]', '::1']
  if (bind !== '127.0.0.1') {
    names.push(...lanAddresses())
    const h = hostname()
    if (h) names.push(h, `${h}.local`)
  }
  // Both framings: a client may or may not include the port in `Host`.
  return [...new Set(names.flatMap((n) => [n, `${n}:${port}`]))]
}

/** How long a recomputed host list is reused. One second of staleness, not one bind's worth. */
const HOSTS_TTL_MS = 1_000
let hostsCache: { key: string; at: number; value: string[] } | null = null

/**
 * `allowedHosts`, recomputed per request behind a one-second memo.
 *
 * Computing it once at bind time is what "recomputed on every bind" actually
 * bought, and it is not enough: a DHCP renewal or a VPN interface coming up
 * mid-session changes the machine's addresses, and a list captured before that
 * refuses the user's own agent with the same blank 401 an attacker gets — the
 * failure mode this allowlist's own comment says it exists to avoid.
 *
 * Enumerating interfaces is a syscall, and this runs before every request, so
 * it is memoised rather than free. A second of staleness cannot span a
 * debugging session.
 */
export function currentAllowedHosts(bind: string, port: number): string[] {
  const key = `${bind}|${port}`
  const now = Date.now()
  if (hostsCache && hostsCache.key === key && now - hostsCache.at < HOSTS_TTL_MS) {
    return hostsCache.value
  }
  const value = allowedHosts(bind, port)
  hostsCache = { key, at: now, value }
  return value
}

export interface BindOutcome {
  /** The port actually bound. May differ from the one asked for. */
  port: number
  /** True when the configured port was taken and the scan found another. */
  scanned: boolean
}

/**
 * Bind the wanted port, then keep trying random ones until something is free.
 *
 * The default is tried FIRST and alone, so the ordinary case is deterministic
 * and the port the user has in their client config is the port they get. Only
 * once it is taken does this pick at random from the ephemeral range, rather
 * than walking `port+1`: consecutive probing collides with whatever block
 * neighbour is already using the default (a second app of the same family
 * typically takes 51821), and it converges slowly when a range is busy. A
 * random draw from ~15k candidates finds a free port in one or two tries
 * essentially always.
 *
 * The outcome is flagged `scanned` so the caller knows the answer was not the
 * one asked for — it is shown to the user and persisted, because a port they
 * were never told about is one their agent cannot reach.
 */
export function listen(
  server: Server,
  bind: string,
  port: number,
  allowScan = true
): Promise<BindOutcome> {
  return new Promise((resolve, reject) => {
    let attempt = 0

    const tryPort = (p: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening)
        if (allowScan && err.code === 'EADDRINUSE' && attempt < SCAN_SPAN) {
          attempt++
          // 49152–65535 is the IANA ephemeral range: nothing registered lives
          // there, so a draw cannot collide with a well-known service.
          tryPort(49_152 + Math.floor(Math.random() * 16_384))
          return
        }
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve({ port: p, scanned: attempt > 0 })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(p, bind)
    }

    tryPort(port)
  })
}

/** The URLs to show the user for a live bind. Loopback first, always. */
export function urlsFor(bind: string, port: number): string[] {
  const loopback = `http://127.0.0.1:${port}/mcp`
  if (bind === '127.0.0.1') return [loopback]
  return [loopback, ...lanAddresses().map((a) => `http://${a}:${port}/mcp`)]
}
