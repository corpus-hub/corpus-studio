import { z } from 'zod'
import { readFileSync, lstatSync, statSync, readdirSync, type Dirent } from 'node:fs'
import { join, resolve, sep, isAbsolute } from 'node:path'
import type { PluginParamDTO } from '@shared/contract/plugins'

/**
 * `plugin.json` — what a folder must contain to be a plugin, and the ONLY thing
 * the app reads before deciding whether to touch the rest of the tree.
 *
 * WHY A DECLARATIVE MANIFEST RATHER THAN ASKING THE CODE. The Settings pane
 * renders a plugin's configuration form from `params`, and the install path
 * decides whether to accept a folder at all. Both of those must happen BEFORE
 * any of the plugin's own code has run — otherwise "is this a plugin?" is
 * answered by executing the thing being asked about, and a folder that is not a
 * plugin gets to run first and be rejected second.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRUST BOUNDARY, STATED PLAINLY: THERE IS NONE AFTER INSTALL.
 *
 * A plugin's entry module is `require`d into the Electron MAIN process. It runs
 * with this application's full privileges: the whole Node API, the user's
 * filesystem, the network, and the same `PluginCtx.db` handle the app itself
 * uses. It can read every paper, note and analysis in the database, read the
 * relay credential file, and open sockets. NOTHING here sandboxes it, and this
 * module must never be read as though something did.
 *
 * What the validation below IS for, and it is worth having on its own terms:
 *   - it stops a MISTAKE (a wrong folder, a half-copied tree, an archive
 *     extracted to the wrong place) from being installed and then failing in a
 *     way that looks like an app bug;
 *   - it stops a plugin folder from writing OUTSIDE its own directory during
 *     INSTALL — traversal, symlinks, absolute entry paths — so the act of
 *     inspecting an untrusted folder cannot itself be the exploit;
 *   - it bounds the copy so a pathological tree cannot fill the disk;
 *   - it keeps manifest strings out of every interpreter they pass near: ids are
 *     `[a-z0-9-]` so they can never be a path segment escape, a SQL fragment or
 *     an IPC channel name, and every displayed string is length-capped and
 *     rendered as TEXT by React.
 *
 * It is NOT a claim that an installed plugin is safe. Installing one is exactly
 * as consequential as running a program the user downloaded, and the install
 * dialog says so in those words.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Bumped only if the shape below changes incompatibly. */
export const MANIFEST_VERSION = 1

export const MANIFEST_FILENAME = 'plugin.json'

/**
 * Caps. Each is a REFUSAL with its own sentence, never a truncation: silently
 * shortening a name means the plugin the user sees is not the one on disk.
 */
export const LIMITS = {
  /** The manifest is read whole into memory before it is known to be JSON. */
  manifestBytes: 64 * 1024,
  files: 2000,
  /** One file's own cap, so a single huge one cannot use the whole budget. */
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  depth: 12,
  params: 32,
  /** Per `choice` param. A list longer than this is a search field, not a choice. */
  options: 12,
  name: 60,
  blurb: 400,
  discloses: 400,
  label: 60,
  help: 400,
  placeholder: 120
} as const

/**
 * Ids are lowercase-and-hyphens, and that is load-bearing three times over: the
 * id becomes a DIRECTORY NAME under the plugins root, a `setting` key
 * (`plugin.<id>.enabled`), and a `data-testid` suffix. `.` and `/` are excluded
 * so `..` and `a/b` are not expressible at all, rather than filtered later; a
 * leading digit is excluded so an id can never be read as a number by anything
 * that coerces; and uppercase is excluded so two ids cannot differ only by case
 * and then collide on a case-insensitive filesystem.
 */
const ID_RE = /^[a-z][a-z0-9-]{1,62}$/

/** Same shape as npm's, loosely: three numbers and an optional pre-release. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** A param key reaches JS property access and a `data-testid`, nothing else. */
const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/

const PARAM_KINDS = ['string', 'number', 'boolean', 'secret', 'url', 'path', 'choice'] as const

/**
 * An option's stored value. Narrow because it is COMPARED, not displayed: the
 * plugin switches behaviour on it and the renderer keys a radio's identity on
 * it, so anything that could differ from itself after a round trip through JSON,
 * a URL or a `data-testid` has no business in it.
 */
const OPTION_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/

/**
 * A printable single-line string.
 *
 * Control characters are refused rather than stripped. They have no legitimate
 * place in a label, and every one of them is a way to make what the user reads
 * differ from what is stored — a `\r` hides everything before it in a terminal,
 * and U+202E reverses the rest of the line on screen while leaving the bytes
 * alone. Refusing keeps "what the manifest says" and "what the user sees" the
 * same string.
 */
function line(max: number): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(s), {
      message: 'contains a control or text-direction character'
    })
}

const optionSchema = z.object({
  value: z.string().regex(OPTION_VALUE_RE),
  label: line(LIMITS.label),
  help: line(LIMITS.help).optional()
})

const paramSchema = z
  .object({
    key: z.string().regex(PARAM_KEY_RE),
    label: line(LIMITS.label),
    kind: z.enum(PARAM_KINDS),
    required: z.boolean(),
    help: line(LIMITS.help),
    placeholder: line(LIMITS.placeholder).optional(),
    options: z.array(optionSchema).min(2).max(LIMITS.options).optional()
  })
  // The two halves of `choice` are checked TOGETHER, here, because neither is
  // meaningful alone. A `choice` with no options renders a control with nothing
  // to pick, which is a field the user cannot answer; `options` on a text field
  // is a manifest that means something the app will not do, and silently
  // ignoring it would let a plugin author believe they had offered a choice.
  .superRefine((p, ctx) => {
    if (p.kind === 'choice' && !p.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'a choice needs options' })
    }
    if (p.kind !== 'choice' && p.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'only a choice has options' })
    }
    const seen = new Set<string>()
    for (const o of p.options ?? []) {
      if (seen.has(o.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'two options share a value' })
      }
      seen.add(o.value)
    }
  })

/**
 * The entry is a path INSIDE the plugin folder, checked here as a string and
 * again as a resolved path in `entryPathWithin`. Both, because the string check
 * is what produces a readable reason and the resolve is what is actually true
 * on this filesystem — `..` is not the only way to leave a directory.
 */
const entrySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !isAbsolute(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s), {
    message: 'must be a path inside the plugin folder, not an absolute one'
  })
  .refine((s) => !s.split(/[\\/]/).includes('..'), { message: 'must not contain ".."' })
  // A colon anywhere. On Windows `notes.txt:payload.js` names an NTFS alternate
  // data stream: it satisfies the suffix rule below, resolves inside the folder,
  // and is invisible to `dir` and to anyone reading the tree — so the file that
  // actually runs is not one an inspector would ever see.
  .refine((s) => !s.includes(':'), { message: 'must not contain a colon' })
  // A NUL truncates the path at the OS boundary, so the string checked here and
  // the path opened would be different strings.
  .refine((s) => !s.includes('\0'), { message: 'must not contain a null character' })
  // JavaScript ONLY. A plugin ships something the runtime can already run; the
  // app does not carry a TypeScript compiler into production for a third party's
  // convenience, and an entry the host had to transpile would be an entry the
  // host had to read and rewrite before deciding whether to run it.
  .refine((s) => /\.(c?js|mjs)$/.test(s), { message: 'must name a .js, .cjs or .mjs file' })

/**
 * A file inside the plugin folder that is NOT the entry, so it carries the
 * containment rules without the JavaScript one — a payload is an extension, a
 * binary, a model, and none of those end in `.js`.
 */
const payloadSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !isAbsolute(s) && !s.startsWith('/') && !/^[A-Za-z]:/.test(s), {
    message: 'must be a path inside the plugin folder, not an absolute one'
  })
  .refine((s) => !s.split(/[\\/]/).includes('..'), { message: 'must not contain ".."' })
  .refine((s) => !s.includes(':'), { message: 'must not contain a colon' })
  .refine((s) => !s.includes('\0'), { message: 'must not contain a null character' })

export const manifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    id: z.string().regex(ID_RE),
    name: line(LIMITS.name),
    version: z.string().regex(VERSION_RE),
    entry: entrySchema,
    blurb: line(LIMITS.blurb),
    /** Named in the enable-consent sentence: what leaves this machine. */
    discloses: line(LIMITS.discloses),
    /**
     * What the setup buttons are for, in the plugin's words. Optional, and
     * meaningless without the `plugin-setup` capability — but it lives HERE
     * rather than behind a verb because it is DESCRIPTION, and description is
     * read without running the code. A sentence introducing a control is one the
     * pane wants before it has decided to load the folder.
     */
    setupHelp: line(LIMITS.help).optional(),
    /**
     * A file this plugin's payload cannot be missing if it really shipped,
     * relative to the plugin's own folder.
     *
     * DECLARED HERE so the app's payload gate can check a bundled plugin without
     * knowing which plugins exist. It used to read from a table keyed by plugin
     * id, which put one plugin's name in the app's own source — the thing the
     * capability model exists to prevent, arriving through the packager rather
     * than through the UI.
     *
     * ONE path, never a glob: the gate names the missing file, and "some of these
     * are absent" is not something a build failure can act on.
     */
    payload: payloadSchema.optional(),
    params: z.array(paramSchema).max(LIMITS.params).default([])
  })
  // Unknown keys are DROPPED rather than refused: a manifest written for a later
  // build of this app must still install here, and the fields this version does
  // not know about are ones it also does not act on.
  .strip()

export type PluginManifest = z.infer<typeof manifestSchema> & { params: PluginParamDTO[] }

/**
 * A validation failure the USER reads. `reason` is a whole sentence written for
 * someone who chose a folder in a file picker, never a raw `Error.message` and
 * never a stack — an `ENOENT` with a path in it is neither actionable nor
 * something to paste into a UI.
 */
export class ManifestError extends Error {
  readonly code: string
  constructor(code: string, reason: string) {
    super(reason)
    this.code = code
    this.name = 'ManifestError'
  }
}

/** The manifest's own path, given a plugin folder. */
export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILENAME)
}

/**
 * Read and validate `<dir>/plugin.json`.
 *
 * Reads NOTHING else and executes nothing. Every throw is a `ManifestError`
 * whose message is showable as-is.
 */
export function readManifest(dir: string): PluginManifest {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(dir)
  } catch {
    throw new ManifestError('no-folder', 'That folder could not be opened. It may have been moved or renamed.')
  }
  if (st.isSymbolicLink()) {
    throw new ManifestError(
      'symlink-root',
      'That is a shortcut to another folder rather than a folder. Choose the plugin folder itself.'
    )
  }
  if (!st.isDirectory()) {
    throw new ManifestError('not-a-folder', 'That is a file, not a folder. A plugin is a folder.')
  }

  const file = manifestPath(dir)
  let mst: ReturnType<typeof lstatSync>
  try {
    mst = lstatSync(file)
  } catch {
    throw new ManifestError(
      'no-manifest',
      `That folder has no ${MANIFEST_FILENAME}, so it is not a plugin. Check whether the plugin is in a folder inside the one you chose.`
    )
  }
  if (!mst.isFile()) {
    throw new ManifestError('manifest-not-file', `${MANIFEST_FILENAME} must be a file.`)
  }
  if (mst.size > LIMITS.manifestBytes) {
    throw new ManifestError(
      'manifest-too-big',
      `${MANIFEST_FILENAME} is far larger than any plugin description should be, so it was not read.`
    )
  }

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new ManifestError('manifest-unreadable', `${MANIFEST_FILENAME} could not be read.`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ManifestError('manifest-not-json', `${MANIFEST_FILENAME} is not valid JSON.`)
  }

  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    throw new ManifestError('manifest-invalid', describeIssue(parsed.error))
  }
  const manifest = parsed.data as PluginManifest

  const keys = new Set<string>()
  for (const p of manifest.params) {
    if (keys.has(p.key)) {
      throw new ManifestError(
        'duplicate-param',
        `${MANIFEST_FILENAME} declares the setting “${p.key}” twice, so it is not clear which one applies.`
      )
    }
    keys.add(p.key)
  }

  return manifest
}

/**
 * One issue, turned into a sentence.
 *
 * The FIRST issue only. Zod reports every failure, and a list of them is a
 * developer's diff, not something a user chooses a different folder because of.
 */
function describeIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  const where = issue?.path.length ? `“${issue.path.join('.')}”` : 'a required field'
  if (issue?.code === 'invalid_literal' || issue?.path[0] === 'manifestVersion') {
    return `That plugin was written for a different version of this app: ${MANIFEST_FILENAME} must say "manifestVersion": ${MANIFEST_VERSION}.`
  }
  if (issue?.path[0] === 'id') {
    return `${MANIFEST_FILENAME} has no usable id. An id is lowercase letters, digits and hyphens, starting with a letter — for example "my-plugin".`
  }
  if (issue?.path[0] === 'entry') {
    return `${MANIFEST_FILENAME}’s "entry" must name a file inside the plugin folder, such as "dist/index.js".`
  }
  if (issue?.path[0] === 'version') {
    return `${MANIFEST_FILENAME}’s "version" must be three numbers, such as "1.0.0".`
  }
  if (issue?.path.includes('options')) {
    return `${MANIFEST_FILENAME} declares a setting the user picks from a list, but its alternatives are missing or repeat one another. A "choice" needs at least two options, each with its own value.`
  }
  return `${MANIFEST_FILENAME} is missing or has a bad value for ${where}.`
}

/**
 * Resolve the manifest's `entry` inside `dir`, refusing anything that lands
 * outside it.
 *
 * The string checks in `entrySchema` already reject `..` and absolute paths;
 * this is the check that holds when they are circumvented some way the regex
 * did not anticipate. Path validation that is done ONCE, as a string, is the
 * shape of every traversal bug ever written.
 */
export function entryPathWithin(dir: string, entry: string): string {
  const root = resolve(dir)
  const target = resolve(root, entry)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ManifestError(
      'entry-escapes',
      'That plugin’s starting file points outside its own folder, which a plugin may not do.'
    )
  }
  return target
}

/** What a tree walk found, or the reason it stopped. */
export interface TreeReport {
  files: string[]
  dirs: string[]
  totalBytes: number
}

/**
 * Walk a candidate plugin folder, refusing anything that is not a plain file or
 * a plain directory.
 *
 * SYMLINKS ARE REFUSED OUTRIGHT rather than skipped or dereferenced. A skipped
 * link installs a plugin missing the file it needs and fails later for a reason
 * that names nothing; a dereferenced one copies whatever it points at — which
 * is how `ln -s ~/.ssh keys` inside a plugin folder becomes a copy of the
 * user's private keys sitting in the app's own directory, world-readable to
 * anything that can read the app's data. Refusing is the only answer that is
 * neither of those, and it is stated to the user with the offending path.
 *
 * Sockets, FIFOs and device files are refused for the plainer reason that
 * copying one either blocks forever or reads an infinite stream.
 *
 * The walk is its own recursion with an explicit depth cap rather than
 * `readdirSync(recursive)`: a cap that is checked after the walk has finished
 * is not a cap.
 */
export function walkPluginTree(dir: string): TreeReport {
  const root = resolve(dir)
  const files: string[] = []
  const dirs: string[] = []
  let totalBytes = 0

  const visit = (abs: string, rel: string, depth: number): void => {
    if (depth > LIMITS.depth) {
      throw new ManifestError(
        'too-deep',
        `That folder nests more than ${LIMITS.depth} levels deep, which no plugin needs, so it was not installed.`
      )
    }
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(abs, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      throw new ManifestError('unreadable-folder', `Part of that folder (${rel || '.'}) could not be read.`)
    }
    for (const ent of entries) {
      const childAbs = join(abs, ent.name)
      const childRel = rel ? `${rel}/${ent.name}` : ent.name
      // `withFileTypes` reports the LINK itself, never its target, which is what
      // makes this check meaningful — a `statSync` here would follow it and see
      // a directory.
      if (ent.isSymbolicLink()) {
        throw new ManifestError(
          'symlink',
          `That folder contains a shortcut (${childRel}). A plugin folder must contain only real files, because a shortcut can point anywhere on this computer.`
        )
      }
      if (ent.isDirectory()) {
        dirs.push(childRel)
        visit(childAbs, childRel, depth + 1)
        continue
      }
      if (!ent.isFile()) {
        throw new ManifestError(
          'special-file',
          `That folder contains something that is neither a file nor a folder (${childRel}), so it was not installed.`
        )
      }
      files.push(childRel)
      if (files.length > LIMITS.files) {
        throw new ManifestError(
          'too-many-files',
          `That folder holds more than ${LIMITS.files} files, which is far more than a plugin, so it was not installed.`
        )
      }
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(childAbs)
      } catch {
        throw new ManifestError('unreadable-file', `A file in that folder (${childRel}) could not be read.`)
      }
      // A HARD LINK reports as an ordinary file to both `Dirent` and `lstat`, so
      // the symlink refusal above does not cover it. Copying one is not a
      // privilege escalation — its target is readable by this user already — but
      // it silently relocates a file the user did not mean to hand over, and
      // `ln ~/.ssh/id_rsa vendor.js` inside a plugin folder is not something to
      // carry into the app's own directory without saying so.
      if (st.nlink > 1) {
        throw new ManifestError(
          'hard-link',
          `That folder contains a file that is a second name for a file elsewhere on this computer (${childRel}), so it was not installed.`
        )
      }
      if (st.size > LIMITS.fileBytes) {
        throw new ManifestError(
          'file-too-large',
          `A file in that folder (${childRel}) is larger than ${Math.round(LIMITS.fileBytes / (1024 * 1024))} MB, which is far more than a plugin needs, so it was not installed.`
        )
      }
      totalBytes += st.size
      if (totalBytes > LIMITS.totalBytes) {
        throw new ManifestError(
          'too-large',
          `That folder is larger than ${Math.round(LIMITS.totalBytes / (1024 * 1024))} MB, which is far more than a plugin, so it was not installed.`
        )
      }
    }
  }

  visit(root, '', 0)
  return { files, dirs, totalBytes }
}

/** Does this folder look like a plugin at all? Used to skip junk while scanning. */
export function looksLikePlugin(dir: string): boolean {
  try {
    return lstatSync(manifestPath(dir)).isFile()
  } catch {
    return false
  }
}
