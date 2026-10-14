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
 * The default SQLite path — SEPARATE for an installed app and a checkout.
 *
 *   - packaged      <userData>/corpus.sqlite    the user's real corpus
 *   - from a repo   <repo>/data/corpus.sqlite   development scratch
 *
 * WHY THESE MUST NOT BE ONE FILE. A checkout carries `seed:fresh`, which
 * DELETES the database and rebuilds it from sample data. While both resolved
 * here, that command — whose only purpose is to set up a development fixture —
 * destroyed the INSTALLED app's corpus instead: five projects and 121 papers
 * replaced by twenty seeded ones, recoverable only because a backup happened to
 * exist. Care at the call site cannot fix this, because the call site was not
 * wrong; the path was. A destructive development command must not be ABLE to
 * name the user's data, and the only way to guarantee that is for the two to be
 * different files.
 *
 * This mirrors `storageRootPath()` below, which has always drawn exactly this
 * line for the PDF library. The database not drawing it was the anomaly.
 *
 * The reason this function exists still holds INSIDE each half: the app, the
 * seeder and the verify scripts all call it, so from a checkout they agree on
 * one file and "seed once, launch, see data" still holds — it is simply the
 * repo's file now, never the user's.
 *
 * `CORPUS_DB_PATH` still outranks both; e2e points each test at a temp DB.
 */
export function defaultDbPath(): string {
  const env = process.env.CORPUS_DB_PATH
  if (env && env.trim()) return env
  const repo = isPackaged() ? null : repoRootOrNull()
  return repo ? join(repo, 'data', 'corpus.sqlite') : join(userDataDir(), 'corpus.sqlite')
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
