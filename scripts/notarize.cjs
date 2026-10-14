// electron-builder `afterSign` hook: notarize the macOS app IF, and only if,
// credentials are present.
//
// Deliberately a no-op without credentials, so an unsigned local build on any
// machine still succeeds. Making notarization mandatory would mean nobody
// without an Apple Developer account could produce a working local build —
// including this repo's Linux development host.
//
// Requires all three of APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.
// See docs/packaging.md for what the user must supply.

exports.default = async function notarizeIfConfigured(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log(
      '[notarize] skipped — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID ' +
        'not all set. The .app is UNSIGNED and Gatekeeper will quarantine it on ' +
        'another Mac. See docs/packaging.md.'
    )
    return
  }

  // Loaded lazily: @electron/notarize is only needed on a signing host, so a
  // Linux build must not fail at require-time for a package it will never use.
  let notarize
  try {
    ;({ notarize } = require('@electron/notarize'))
  } catch {
    throw new Error(
      '[notarize] credentials are set but @electron/notarize is not installed. ' +
        'Run: npm i -D @electron/notarize'
    )
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`[notarize] submitting ${appName}.app to notarytool…`)
  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  })
  console.log('[notarize] done')
}
