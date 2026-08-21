// The on-disk format of an exported settings file: AES-256-GCM inside a small
// plaintext header.
//
// WHAT THIS IS, PLAINLY. The key below ships inside every copy of the app, so
// anyone holding the binary can recover it — `strings` on the bundle, or reading
// this file. This is OBFUSCATION, not secrecy. It stops a settings file being
// readable by accident (a backup tool indexing it, a colleague opening it in a
// text editor, a support ticket with it attached) and it stops nothing else.
//
// The user asked for exactly this, having been told exactly that. The
// consequence they own, and which the UI states: THE EXPORTED FILE IS A
// CREDENTIAL, because it can contain the gateway API key. It should be handled
// like the key itself — not mailed, not committed, not left in a shared folder.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The one and only key, forever.
 *
 * NEVER CHANGE THIS VALUE. Every future build must decrypt every file every
 * past build wrote; a settings export is the thing a user reaches for after
 * reinstalling, possibly years later, and a rotated key turns all of those into
 * unopenable files with no recovery path. There is nothing to gain by rotating
 * it either — see the note above: the key is public by construction, so a new
 * one would be exactly as public and would only break old files.
 *
 * If a genuinely secret scheme is ever wanted, it must arrive as a NEW format
 * version that this constant still decrypts, never as a new value here.
 */
const KEY = Buffer.from('c0rpu5-5tud10-settings-transfer-v1-aes256gcm-key', 'utf8').subarray(0, 32)

/** Bytes 0..8 of every file, so a wrong file is rejected before any crypto. */
const MAGIC = Buffer.from('CSTUDIOS\x01', 'binary')

/**
 * The format version, carried in the header AND inside the plaintext.
 *
 * In the header so a future reader can pick a decoder before decrypting; inside
 * so a file whose header was edited to claim a version it is not cannot pass —
 * the inner copy is under the authentication tag and the outer one is not.
 */
export const ENVELOPE_VERSION = 1

/**
 * What a file that fails to authenticate is reported as.
 *
 * ONE message for every failure mode — wrong magic, truncated file, flipped bit,
 * a file from another application — because they are the same fact to the user
 * ("this is not a file I can open") and distinguishing them would only describe
 * the internals of a format they cannot inspect. Nothing is applied: the failure
 * happens before a single value is read, so a partial import is not reachable.
 */
export const NOT_A_SETTINGS_FILE =
  'That is not a Corpus Studio settings file, or it is damaged. Nothing was changed.'

export class SettingsFileError extends Error {
  constructor() {
    super(NOT_A_SETTINGS_FILE)
    this.name = 'SettingsFileError'
  }
}

/**
 * Layout, in order:
 *   MAGIC (9) | version (1) | IV (12) | tag (16) | ciphertext (rest)
 *
 * A 12-byte IV is GCM's native size and is drawn fresh per file from
 * `randomBytes`, so two exports of identical settings are not byte-identical —
 * which matters because a settings file is the kind of thing that gets synced
 * and diffed. The tag sits in the header rather than appended, so the reader can
 * hand it to the decipher before streaming anything.
 */
const OFF_VERSION = MAGIC.length
const OFF_IV = OFF_VERSION + 1
const OFF_TAG = OFF_IV + 12
const OFF_CIPHERTEXT = OFF_TAG + 16

export function sealSettings(payload: unknown): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const version = Buffer.from([ENVELOPE_VERSION])
  return Buffer.concat([MAGIC, version, iv, cipher.getAuthTag(), body])
}

/**
 * Decrypt, or throw `SettingsFileError`.
 *
 * The tag is verified by `final()`, so a file that has been altered by even one
 * byte throws here — before the caller has seen any of its contents, let alone
 * applied one. That is what makes "never applied partially" a property of the
 * format rather than a promise the import code has to keep.
 */
export function openSettings(file: Buffer): unknown {
  if (file.length <= OFF_CIPHERTEXT) throw new SettingsFileError()
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new SettingsFileError()
  if (file[OFF_VERSION] !== ENVELOPE_VERSION) throw new SettingsFileError()
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, file.subarray(OFF_IV, OFF_TAG))
    decipher.setAuthTag(file.subarray(OFF_TAG, OFF_CIPHERTEXT))
    const plain = Buffer.concat([
      decipher.update(file.subarray(OFF_CIPHERTEXT)),
      decipher.final()
    ])
    return JSON.parse(plain.toString('utf8'))
  } catch {
    // Deliberately swallowing the cause. `err.message` from node's crypto or
    // from JSON.parse describes the file's internals, and this message is
    // rendered to the user — who can act on "damaged" and cannot act on
    // "Unsupported state or unable to authenticate data".
    throw new SettingsFileError()
  }
}
