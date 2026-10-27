import { homedir } from 'node:os'
import { userDataDir } from '../db/paths'

/**
 * Collapse absolute paths in anything on its way out of this process.
 *
 * A better-sqlite3 or `fs` failure carries a full path, and on Linux that path
 * starts `/home/<username>/` — so an error message handed to an agent, or
 * written to a log the user may share, discloses the OS account name for
 * nothing. `health.ts` already returns only a basename for exactly this reason;
 * this makes the same care hold on the paths nobody chose to return.
 *
 * Longest prefix first, because the userData directory lives INSIDE the home
 * directory and replacing home first would leave `~/.config/corpus-studio`
 * where `<userData>` is more useful.
 *
 * The two known prefixes are then a SPECIAL CASE of the general sweep that
 * follows, not the whole of it. This app deliberately stores PDFs on mounts
 * outside the home directory — a NAS, a second disk — so the commonest absolute
 * path in a stage failure looks like `/media/<account>/Disk/papers/x.pdf` and
 * matched neither prefix. It travelled verbatim, account name included, through
 * the one code path that exists to stop exactly that. So anything still shaped
 * like an absolute path after the named substitutions is collapsed too; the
 * named ones run first because `~/…` and `<userData>/…` tell the reader
 * something useful that "a folder" does not.
 */
export function scrubPaths(text: string): string {
  let out = text
  const data = userDataDir()
  const home = homedir()
  if (data) out = out.split(data).join('<userData>')
  if (home) out = out.split(home).join('~')
  return redactPath(out)
}

/**
 * Collapse an absolute path inside a human sentence to the words "a folder".
 *
 * Deliberately not `scrubPaths`: that rewrites the home and userData directories
 * and leaves everything else standing, so a vault on a NAS or a second disk
 * (`/media/<user>/…`, the documented base_dir case) travels intact — account
 * name included. Here the LOCATION is what must not leave, and the sentence
 * around it is what the agent needs.
 *
 * ANCHORED ON A REAL ROOT, and that is the whole difficulty. A pattern of "a
 * slash and then anything" also eats `read/write`, `2026/07/28`, `s/foo/bar/g`
 * and — the one that matters here — the unit strings this app's own measurements
 * are written in: `/mg/mL`, `/min/mg`, `/s/M`. Redacting those turns a reported
 * value into nonsense, which is a worse outcome than the leak, so a match must
 * begin at a directory that actually exists at the root of a real system, a
 * Windows drive, a UNC share, or `~`. A leading slash alone is not enough.
 *
 * URLs are matched FIRST and passed through unchanged. Without that branch the
 * `//` of `https://doi.org/10.1038/…` is itself a leading double separator, so
 * every DOI and publisher link this app exists to return came back as
 * "a folder" — silent corruption of the payload, in the name of protecting it.
 * `file://` is excluded from the exemption: it is a filesystem path wearing a
 * URL's costume and must still be collapsed.
 *
 * No lookbehind, deliberately. An earlier version anchored with `(?<![\w:~.-])`,
 * which silently stopped matching when the preceding character was a word
 * character — and in a JSON-encoded stack trace the newline before a path is the
 * two characters `\` `n`, so every path on a continuation line went out intact.
 */
const PATH_ROOTS =
  'home|Users|users|media|mnt|Volumes|var|tmp|opt|srv|etc|usr|root|data|net|private|run|snap|Library|System|Applications|storage|share|export|scratch|work|nas'

const PATH_RE = new RegExp(
  String.raw`(file:\/\/\S*)|((?!file:)[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]*)|([A-Za-z]:[\\\/][^\s"'<>]*|\\\\[\w.-]+\\[^\s"'<>]*|~[\\\/][^\s"'<>,;)]*|\/(?:${PATH_ROOTS})\/[^\s"'<>,;)]*)`,
  'g'
)

export function redactPath(text: string): string {
  return text.replace(PATH_RE, (_m, _fileUrl, url) => url ?? 'a folder')
}

/**
 * `scrubPaths` over every string INSIDE a value, before it is serialized.
 *
 * Applied to the encoded JSON instead, this corrupts the document it is meant to
 * protect. A path may legally contain a double quote, and in JSON that quote is
 * `\"` — so a match that runs up to it consumes the escaping backslash and the
 * replacement closes the string early, handing the agent something
 * `JSON.parse` rejects. And a path on the second line of a stack trace sits
 * after the two characters `\` `n`, which no scan of the encoded form reads as a
 * newline. Walking the VALUE sidesteps both: each string is scrubbed on its own,
 * and `JSON.stringify` then escapes whatever is left, correctly.
 *
 * Keys are walked as well as values. A `Record<string, …>` keyed by path is
 * exactly the shape nobody remembers to redact.
 */
export function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubPaths(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === 'object') {
    // Anything with a custom serialization (Date, Buffer, Uint8Array) is left
    // alone: rebuilding it as a plain object would change the wire shape.
    if (value.constructor !== Object) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[scrubPaths(k)] = scrubValue(v)
    return out
  }
  return value
}

/**
 * Secrets whose exact value this process holds, for `redactSecrets`' value pass.
 *
 * REGISTERED rather than imported, and living HERE rather than in `auth.ts`,
 * for two reasons. The gateway credential must not import the MCP auth module —
 * which reaches the whole DB layer — merely to protect itself; that is an
 * import cycle waiting for a load-order change. And a READER, unlike a value,
 * keeps the credential inside the closure that is the entire reason it is safe:
 * nothing here ever holds the string.
 *
 * KEYED BY ID, and that is load-bearing rather than tidy. A `Set` of closures
 * never dedupes, and `GatewayCredential` is reconstructed on every read of the
 * gateway config — so a Set would grow one entry per visit to Settings, and
 * `liveSecrets()` runs on every audit line and every tool result. That is a
 * `split`/`join` over a multi-megabyte payload once per accumulated closure, on
 * the thread that paints the window.
 */
const secrets = new Map<string, () => string | null>()

export function registerSecret(id: string, read: () => string | null): void {
  secrets.set(id, read)
}

/**
 * A registered secret whose reader threw, so its value is unknown to the pass
 * that has to remove it.
 *
 * "Unreadable is unleakable" was FALSE and is the whole reason this type exists.
 * The reader is the redactor's only way of learning the value; the rest of the
 * process holds it perfectly well. A gateway key the keyring momentarily refuses
 * to decrypt, or a relay session token read while it is being rotated, is still
 * sitting in the error message or the tool result about to be written — the only
 * thing that failed is our ability to FIND it there. Skipping the rule turns
 * "we could not check" into "there is nothing to remove", which is the exact
 * shape of every silent security gap in this file's neighbourhood.
 */
export class SecretUnreadableError extends Error {
  constructor(readonly secretId: string, readonly cause: unknown) {
    super(`the registered secret "${secretId}" could not be read, so it cannot be redacted`)
  }
}

/**
 * Every secret value this process holds.
 *
 * THROWS `SecretUnreadableError` rather than skipping a reader that fails. The
 * caller decides what fail-closed means for its payload — `redactKnownSecrets`
 * suppresses the text entirely — but no caller gets to be told the sweep was
 * complete when it was not.
 */
export function liveSecrets(): string[] {
  const out: string[] = []
  for (const [id, read] of secrets) {
    let v: string | null
    try {
      v = read()
    } catch (e) {
      throw new SecretUnreadableError(id, e)
    }
    if (v) out.push(v)
  }
  return out
}
