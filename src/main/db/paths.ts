// Single source of truth for the DEFAULT database location.
//
// This module is deliberately dependency-free (no `electron` import) so the
// EXACT same path is produced by:
//   - the running app (src/main/index.ts, real Electron), and
//   - the CLI scripts run under `ELECTRON_RUN_AS_NODE=1` (seed, verify),
// where the Electron `app` object is `undefined` and `app.getPath('userData')`
// is unavailable.
//
// Historically the app, the seed runner and the verify script each computed a
// DIFFERENT default path (userData/, cwd/.corpus-data/, cwd/data/), so
// `npm start` opened an empty DB while `npm run seed:fresh` seeded a different
// file — the app launched blank. Everything now funnels through
// `defaultDbPath()` so "seed once, launch, see data" holds.
//
// The computed path mirrors Electron's own `app.getPath('userData')`
// convention for app name `corpus-studio`:
//   - Linux:   $XDG_CONFIG_HOME/corpus-studio   (fallback ~/.config/corpus-studio)
//   - macOS:   ~/Library/Application Support/corpus-studio
//   - Windows: %APPDATA%/corpus-studio           (fallback ~/AppData/Roaming/…)
// so the deterministic path equals what the real Electron app resolves to.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { isPackaged, repoRootOrNull } from '../resources'

/** Electron app name — MUST equal package.json "name" so userData dir matches. */
export const APP_NAME = 'corpus-studio'

/** The per-user config/data directory Electron would use for this app. */
export function userDataDir(): string {
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME)
    case 'win32': {
      const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
      return join(appData, APP_NAME)
    }
    default: {
      // linux + others
      const xdg = process.env.XDG_CONFIG_HOME
      const base = xdg && xdg.trim() ? xdg : join(home, '.config')
      return join(base, APP_NAME)
    }
  }
}

/**
 * The default SQLite path used by the app AND the seed/verify scripts.
 * `CORPUS_DB_PATH` (used by e2e specs to point at per-test temp DBs) always
 * wins; otherwise the shared userData path is used.
 */
export function defaultDbPath(): string {
  const env = process.env.CORPUS_DB_PATH
  if (env && env.trim()) return env
  return join(userDataDir(), 'corpus.sqlite')
}

/** Label carried by the app-owned storage location, in the DB and the UI. */
export const MANAGED_STORAGE_LABEL = 'Corpus Studio library'

/**
 * The app-owned PDF library — the one storage location Corpus Studio creates
 * and manages itself, as opposed to the external roots a user adds in Settings.
 *
 * Unlike the database this MAY sit on a network filesystem (only WAL is unsafe
 * there), but the managed default is deliberately local:
 *   - from a checkout   <repo>/data/pdfs      (gitignored, easy to inspect)
 *   - packaged          <userData>/pdfs       (no repo exists to write into)
 * `CORPUS_PDF_DIR` overrides both, which is how the e2e specs point each test at
 * its own temp library.
 *
 * It lives next to `defaultDbPath()` for the same reason that function exists:
 * the app, the seeder and the verify scripts must compute a byte-identical path
 * or the seeded rows describe a directory the app never looks in.
 */
export function storageRootPath(): string {
  const env = process.env.CORPUS_PDF_DIR
  if (env && env.trim()) return env
  const repo = isPackaged() ? null : repoRootOrNull()
  return repo ? join(repo, 'data', 'pdfs') : join(userDataDir(), 'pdfs')
}
