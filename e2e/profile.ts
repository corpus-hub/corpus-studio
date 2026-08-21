/*
 * Per-run USER PROFILE isolation for the E2E suite.
 *
 * Every test launches the REAL built app, and the real app writes to the real
 * per-user data directory (`userDataDir()` in src/main/db/paths.ts): the gateway
 * credential (`gateway.env`), MCP tokens, audit logs, devlogs, the Corpus
 * Retriever native-host manifest. `CORPUS_DB_PATH` isolates the DATABASE and
 * nothing else, so a spec that types into Settings was writing its literals into
 * the developer's live profile.
 *
 * That is not theoretical. `e2e/settings.spec.ts` types an endpoint of
 * `http://127.0.0.1:9/<uuid>` and a key of `secret-under-test`, and twice it
 * overwrote the real `gateway.env`. The damage is silent and expensive: every
 * subsequent LLM call 403s, the pipeline settles each paper as "carries nothing
 * for this schema" with zero facts, and those refusals are CACHED — one run
 * poisoned ten schema-extract runs and killed 39 of 40 passes of a corpus run.
 *
 * So the profile is redirected HERE, in globalSetup, the same way the virtual
 * display is: by overwriting the variables in the runner's own `process.env`
 * before the workers fork. Anything that spreads `process.env` — `launchApp`,
 * `seedDb`, and any spec that reaches for `_electron.launch` directly — inherits
 * the redirect without opting in. A protection each spec must remember is a
 * protection that will be forgotten, and being forgotten by exactly one spec is
 * the whole of this bug.
 *
 * `userDataDir()` derives from `XDG_CONFIG_HOME` on Linux, `APPDATA` on Windows
 * and `homedir()` on macOS, so all three are redirected. `HOME` is set only on
 * macOS, where it is the only lever; on Linux moving `HOME` would relocate far
 * more than this app's data.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { userDataDir } from '../src/main/db/paths'

/** Env var carrying the provisioned throwaway profile root to the workers. */
export const PROFILE_ENV = 'CORPUS_E2E_PROFILE'
/** Env var carrying the REAL profile path, captured before it was redirected. */
export const REAL_PROFILE_ENV = 'CORPUS_E2E_REAL_USER_DATA'

const ROOT = resolve(__dirname, '..')

/**
 * The library the app provisions PDFs into (`storageRootPath()`), redirected off
 * the checkout's own `data/pdfs` so a spec that imports, optimises or prunes
 * cannot touch the corpus a developer actually reads.
 *
 * It is a REPO-LOCAL directory, not one under `/tmp` and not one under
 * `test-results/`. The seed hardlinks ~95 MB of corpus in, and a destination on
 * another filesystem turns every link into a copy; `test-results/` is
 * Playwright's `outputDir`, which the runner clears at the start of a run.
 */
function pdfDir(): string {
  return join(ROOT, '.e2e-pdfs')
}

type EnvMap = Record<string, string | undefined>

/** Write the redirect into an env map. Used for `process.env` and for children. */
function applyProfile<T extends EnvMap>(env: T, profile: string): T {
  const e = env as EnvMap
  e.XDG_CONFIG_HOME = join(profile, 'config')
  e.XDG_DATA_HOME = join(profile, 'data')
  e.XDG_CACHE_HOME = join(profile, 'cache')
  e.XDG_STATE_HOME = join(profile, 'state')
  if (process.platform === 'win32') e.APPDATA = join(profile, 'AppData', 'Roaming')
  if (process.platform === 'darwin') e.HOME = profile
  e.CORPUS_PDF_DIR = pdfDir()
  return env
}

/** Every variable `applyProfile` overwrites, so teardown can put them back. */
const REDIRECTED = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'HOME',
  'CORPUS_PDF_DIR'
] as const

const saved = new Map<string, string | undefined>()

/**
 * Create the throwaway profile and redirect this process (and therefore every
 * worker and every child) at it. Idempotent, and safe to call from a worker that
 * inherited an already-provisioned one.
 */
export function provisionProfile(): string {
  const existing = process.env[PROFILE_ENV]
  if (existing) return existing

  // Captured BEFORE the redirect, so it is the developer's real directory and
  // not the one we are about to install.
  const real = userDataDir()
  const profile = mkdtempSync(join(tmpdir(), 'corpus-e2e-profile-'))
  mkdirSync(join(profile, 'config'), { recursive: true })
  mkdirSync(pdfDir(), { recursive: true })

  for (const key of REDIRECTED) saved.set(key, process.env[key])
  process.env[PROFILE_ENV] = profile
  process.env[REAL_PROFILE_ENV] = real
  applyProfile(process.env, profile)
  return profile
}

/**
 * Remove the throwaway profile and put this process's own environment back.
 * Called from globalTeardown and from the exit/signal handlers.
 *
 * The PDF library is NOT deleted: it holds hardlinks to the corpus, costs
 * nothing to keep, and keeping it is what makes the next run's seed a link
 * rather than 95 MB of copying.
 */
export function removeProfile(): void {
  const profile = process.env[PROFILE_ENV]
  if (!profile) return
  delete process.env[PROFILE_ENV]
  delete process.env[REAL_PROFILE_ENV]
  for (const key of REDIRECTED) {
    const prior = saved.get(key)
    if (prior === undefined) delete process.env[key]
    else process.env[key] = prior
  }
  saved.clear()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* a leftover temp dir is not worth failing a run over */
  }
}

/**
 * The env for launching (or seeding) the app: `process.env` plus the profile
 * redirect, re-applied rather than merely inherited.
 *
 * It also ASSERTS that the app being launched cannot resolve the real profile.
 * The failure this guards is invisible at the time it happens — the credential
 * is gone and the next hundred analyses quietly say the papers contain nothing —
 * so it is converted into a loud failure of the test that would have caused it.
 */
export function profileEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const profile = provisionProfile()
  const env = applyProfile({ ...process.env }, profile)
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }

  const real = process.env[REAL_PROFILE_ENV]
  const resolved = resolveUserDataDir(env)
  if (real && resolve(resolved) === resolve(real)) {
    throw new Error(
      `E2E refuses to launch: the app would write to the REAL user profile at ${real}.\n` +
        'That silently overwrites gateway.env (the live LLM credential), MCP tokens and ' +
        'audit logs. Launch through e2e/helpers/electron.ts, which applies the throwaway ' +
        'profile from e2e/profile.ts.'
    )
  }
  return env as Record<string, string>
}

/**
 * What `userDataDir()` would return for a given env — the same three branches,
 * evaluated against a map instead of `process.env`, so the guard can ask about
 * the CHILD's environment rather than its own.
 */
function resolveUserDataDir(env: Record<string, string | undefined>): string {
  const APP = 'corpus-studio'
  if (process.platform === 'darwin') {
    return join(env.HOME ?? '', 'Library', 'Application Support', APP)
  }
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(env.USERPROFILE ?? '', 'AppData', 'Roaming'), APP)
  }
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(env.HOME ?? '', '.config'), APP)
}
