// The one HTTP client every gateway request goes through.
//
// It exists because two things about this connection are NOT Node's defaults,
// and both were discovered as failures that named the wrong cause:
//
//   - TLS TRUST. Node and Electron ship their own Mozilla root list and ignore
//     the operating system's store entirely, so a gateway published behind a
//     company/self-hosted CA — one the machine itself trusts, that `curl` and
//     the browser accept without a murmur — fails every request with
//     `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The app reported that as "gateway
//     unreachable", which sends the user to check an endpoint that is answering.
//   - TIMEOUTS. Node's `fetch` gives up waiting for headers after 300 s, and a
//     schema extraction over a full paper can legitimately take longer. The
//     deadline that matters is the gate's 15-minute wall-clock cap, which is
//     also the thing holding the single slot; a second, shorter, client-side one
//     only abandons work the gateway is still paying for.
//
// Built lazily and once, and shared by the pre-flight and the completion path so
// the probe cannot succeed over a trust configuration the real call does not
// have — a health check that says "ready" through a different client than the
// one that will fail is worse than no health check.

import { readFileSync } from 'node:fs'
import { rootCertificates } from 'node:tls'
import { Agent } from 'undici'

/**
 * The well-known locations of the OS trust bundle, most common first.
 *
 * Nothing here is macOS or Windows: those keep their roots in a keychain rather
 * than a file, no path can read them, and the result is `undefined` — which
 * means "Node's own roots", the behaviour those platforms had already.
 */
const SYSTEM_CA_FILES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian, Ubuntu, Alpine
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora, RHEL
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/ssl/cert.pem' // Arch, BSD
]

let cachedCa: string[] | null | undefined

/**
 * Node's roots PLUS whatever the machine trusts, or null when there is no file.
 *
 * Both, not either: undici's `connect.ca` REPLACES the default list rather than
 * extending it, so handing it only the system bundle on a host whose bundle is
 * sparse would break the public internet to fix one private host. Concatenating
 * can only widen trust to certificates this machine already accepts.
 *
 * `NODE_EXTRA_CA_CERTS` is honoured too, because a user who set the standard
 * escape hatch has already told us the answer.
 */
function trustedCertificates(): string[] | null {
  if (cachedCa !== undefined) return cachedCa
  const extra: string[] = []
  const explicit = process.env.NODE_EXTRA_CA_CERTS?.trim()
  const files = explicit ? [explicit, ...SYSTEM_CA_FILES] : SYSTEM_CA_FILES
  for (const path of files) {
    try {
      const pem = readFileSync(path, 'utf8')
      if (pem.includes('BEGIN CERTIFICATE')) {
        extra.push(pem)
        // One bundle is enough: they are copies of each other on every distro
        // that ships more than one path, and reading all of them would only
        // duplicate the same roots.
        if (!explicit || extra.length > 1) break
      }
    } catch {
      // Absent or unreadable is the normal case for all but one of these.
    }
  }
  cachedCa = extra.length > 0 ? [...rootCertificates, ...extra] : null
  return cachedCa
}

/** Whether the OS trust store was found and is in use. For diagnostics only. */
export function usingSystemTrustStore(): boolean {
  return trustedCertificates() !== null
}

let dispatcher: Agent | null = null

/**
 * The shared agent. Every call to the gateway — probe and completion alike —
 * must use it, or it gets Node's defaults and one of the two failures above.
 */
export function gatewayDispatcher(): Agent {
  if (!dispatcher) {
    const ca = trustedCertificates()
    dispatcher = new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      ...(ca ? { connect: { ca } } : {})
    })
  }
  return dispatcher
}
