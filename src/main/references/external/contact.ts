// The polite-pool contact address, generated once per install.
//
// Crossref and OpenAlex give an identified caller a faster pool and will contact
// them before rate-limiting rather than after. It costs an email. What it must
// NOT cost is the user typing their personal address into a literature tool to
// read papers.
//
// This mirrors `contactEmail()` in the companion browser extension deliberately,
// down to the word list and the domain, so the two halves identify themselves
// the same way to the same services. The extension owns that implementation;
// this is the app-side twin, and the two should be changed together.
//
// NOT DERIVED FROM THE MACHINE, and that is the point worth reading.
// A hostname, a MAC address or a machine-id hash all look like reasonable
// sources of "a unique id for this install", and each is worse than random:
//
//   - A machine fingerprint comes from a SMALL space, so hashing it is
//     reversible by brute force. `hash(hostname)` is not anonymous when there
//     are only so many plausible hostnames.
//   - It correlates the same person across every service that sees it, which is
//     precisely what an address handed to third-party APIs must not do.
//   - A hostname often IS the person ("annas-laptop", "j.smith-workstation").
//
// A random id identifies the INSTALL to the API and nothing else about whoever
// is using it — exactly as much as the API needs and no more.

import { randomInt } from 'node:crypto'
import { getSetting, setSetting } from '../../db/repositories'
import type { DB } from '../../db/connection'

/** Where the generated id is kept, so it survives restarts. */
const CONTACT_ID_KEY = 'references.contact_id'

/**
 * A domain that REALLY RESOLVES.
 *
 * The extension shipped an invented domain once: the address was undeliverable
 * and the identity behind it unfindable, which is worse than sending nothing,
 * because it takes the polite-pool benefit while making the bargain a lie. This
 * host exists and a maintainer who needs to know who is generating load can
 * reach the project through it.
 *
 * Still not a mailbox — Crossref asks for a contact so they can REACH whoever
 * is generating load, and this is a project they can find rather than a person
 * they can email. Closer to the spirit than a domain nobody owns, and short of
 * a real inbox. If a mailbox is ever wanted, point a real domain at one and
 * change this line and the extension's together.
 */
const CONTACT_DOMAIN = 'corpus-hub.github.io'

/**
 * Short and email-shaped: `word.word37@domain`.
 *
 * A 32-character hex string is a machine id wearing an address. This reads like
 * an address while carrying the same information — ~1.9 million combinations,
 * far more than the number of installs, and still nothing about the person.
 */
const CONTACT_WORDS = [
  'ada', 'bell', 'bohr', 'byron', 'cori', 'curie', 'dalton', 'darwin', 'dirac', 'euler',
  'fermi', 'floyd', 'franklin', 'gauss', 'gibbs', 'hertz', 'hodgkin', 'hooke', 'hopper',
  'joule', 'kepler', 'knuth', 'lamarr', 'leakey', 'lovelace', 'mendel', 'newton', 'noether',
  'ohm', 'pascal', 'pauling', 'planck', 'raman', 'rosalind', 'rutherford', 'sanger',
  'shannon', 'tesla', 'turing', 'volta', 'watson', 'wu', 'yalow', 'yonath'
] as const

/**
 * This install's contact address, generated on first use and STABLE thereafter.
 *
 * Stability is not a convenience. A fresh address per request is
 * indistinguishable from evading a rate limit, and would leave these services
 * unable to throttle one bad actor without blocking every user of the app. One
 * stable id per install is what lets them attribute load to an install and
 * throttle it alone.
 *
 * `randomInt` (CSPRNG), not `Math.random`: the id is the only thing separating
 * one install from another, and two installs colliding would make them share a
 * rate limit.
 */
export function contactEmail(db: DB): string {
  const existing = getSetting(db, CONTACT_ID_KEY)
  if (existing) return `${existing}@${CONTACT_DOMAIN}`

  const a = CONTACT_WORDS[randomInt(CONTACT_WORDS.length)]
  const b = CONTACT_WORDS[randomInt(CONTACT_WORDS.length)]
  const id = `${a}.${b}${randomInt(100)}`
  setSetting(db, CONTACT_ID_KEY, id)
  return `${id}@${CONTACT_DOMAIN}`
}
