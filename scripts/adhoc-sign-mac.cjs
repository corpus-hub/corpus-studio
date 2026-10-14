// electron-builder `afterPack` hook: AD-HOC sign the macOS bundle when the real
// signer could not run (i.e. when building anywhere but a Mac).
//
// THIS IS NOT APPLE SIGNING, AND DOES NOT PRETEND TO BE. There is no
// certificate, no Developer ID and no notarization: Gatekeeper still quarantines
// the app and a user still has to right-click → Open the first time. That is the
// intended, accepted state for this project.
//
// WHAT IT FIXES IS EXECUTION, NOT TRUST. On Apple Silicon the KERNEL refuses to
// run an arm64 binary that has no valid signature — this is not a prompt that
// can be clicked through. electron-builder rewrites the bundle (Info.plist,
// helper names, our asar) and then, on Linux, logs "skipped macOS application
// code signing — supported only on macOS" and leaves it. The main executable is
// then left carrying UPSTREAM ELECTRON's ad-hoc signature, whose CodeDirectory
// still claims `identifier: Electron` and hashes contents that no longer exist.
// A STALE signature is worse than none: macOS reports "the application is
// damaged and can't be opened", which right-click → Open cannot bypass, so the
// arm64 build is undeliverable rather than merely untrusted.
//
// An ad-hoc signature is self-contained — a hash of the bundle's own contents,
// requiring no key material and no Apple account — so it can be produced here.
//
// It is deliberately SKIPPED when a real signing identity was used: re-signing
// ad-hoc over a Developer ID signature would silently throw the real one away.

const { existsSync } = require('node:fs')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { join } = require('node:path')

const execFileAsync = promisify(execFile)

/**
 * `rcodesign` (the `apple-codesign` crate) is the only Apple code signer that
 * runs off macOS. It is a developer tool, not a dependency of the app, so it is
 * NOT vendored: a build host that wants macOS artifacts installs it with
 * `cargo install apple-codesign`. Absent, the build still succeeds and says
 * plainly what the resulting artifact cannot do.
 */
const CANDIDATES = [
  'rcodesign',
  join(process.env.HOME ?? '', '.cargo', 'bin', 'rcodesign')
]

async function findSigner() {
  for (const candidate of CANDIDATES) {
    try {
      await execFileAsync(candidate, ['--version'])
      return candidate
    } catch {
      /* try the next one */
    }
  }
  return null
}

/**
 * True when the bundle carries a CERTIFICATE-BACKED signature (as opposed to an
 * ad-hoc one, or none at all).
 *
 * Uses Apple's own `codesign`, which is authoritative and present on any macOS
 * host. `--display -v` prints `Signature=adhoc` for an ad-hoc signature and a
 * `Authority=` chain for a real one; an unsigned bundle exits non-zero.
 */
async function hasRealSignature(appPath) {
  try {
    const { stdout, stderr } = await execFileAsync('codesign', ['--display', '-vv', appPath])
    const out = `${stdout}${stderr}`
    if (/Signature\s*=\s*adhoc/i.test(out)) return false
    return /^Authority=/m.test(out)
  } catch {
    // Non-zero exit = not signed at all (or no codesign, i.e. not a Mac).
    return false
  }
}

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(appPath)) {
    throw new Error(`[adhoc-sign] no .app at ${appPath}`)
  }

  // ASK THE BUNDLE what happened, rather than inferring it from the environment.
  //
  // On macOS electron-builder finds a Developer ID by searching the KEYCHAIN
  // (`findIdentity`, MacTargetHelper.js) — `CSC_LINK`/`CSC_NAME` are only two of
  // the ways an identity can arrive. An earlier version of this hook tested
  // those env vars alone, which meant that on the very host this feature exists
  // for — a Mac with a certificate installed — it would have re-signed ad-hoc
  // OVER a real Developer ID signature and silently thrown it away, taking the
  // notarization with it.
  //
  // A real signature is distinguishable from an ad-hoc one in the bundle
  // itself: an ad-hoc CodeDirectory sets the ADHOC flag, a certificate-backed
  // one does not. That is the actual question, so it is the one asked.
  if (process.platform === 'darwin' && (await hasRealSignature(appPath))) {
    console.log(
      '[adhoc-sign] the bundle already carries a certificate-backed signature — ' +
        'leaving it alone.'
    )
    return
  }

  const entitlements = join(context.packager.info.projectDir, 'build', 'entitlements.mac.plist')
  const { Arch } = require('electron-builder')

  // The hardened runtime is requested in BOTH branches below, and it is what
  // makes the entitlements take effect at all. It matters for one specific
  // reason: library validation would otherwise refuse `vec0.dylib`, which
  // better-sqlite3 dlopen()s at runtime and which is not signed with the app's
  // identity — and sqlite-vec is a hard requirement for opening a corpus, not an
  // optional feature. `disable-library-validation` is exactly that exemption.

  if (process.platform === 'darwin') {
    // On a Mac, use APPLE'S OWN `codesign`. It ships with the OS and the Xcode
    // command line tools, so it needs no extra install, and `-s -` is the
    // canonical way to ad-hoc sign. `--deep` because the bundle contains nested
    // frameworks and helper apps that each need their own signature.
    await execFileAsync(
      'codesign',
      [
        '--force',
        '--deep',
        '--options', 'runtime',
        '--entitlements', entitlements,
        '--sign', '-',
        appPath
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    )
    console.log(
      `[adhoc-sign] ${Arch[context.arch]}: ad-hoc signed ${appPath} with codesign ` +
        '(no certificate — Gatekeeper will still require right-click → Open).'
    )
    return
  }

  // Off macOS, `rcodesign` is the only Apple code signer available.
  const signer = await findSigner()
  if (signer == null) {
    console.warn(
      '[adhoc-sign] rcodesign NOT FOUND — the bundle keeps upstream Electron\'s ' +
        'stale ad-hoc signature. On Apple Silicon macOS will refuse to launch it ' +
        '("application is damaged"). Install it with `cargo install apple-codesign`. ' +
        'See docs/packaging.md.'
    )
    return
  }

  await execFileAsync(
    signer,
    [
      'sign',
      '--code-signature-flags', 'runtime',
      '--entitlements-xml-path', entitlements,
      appPath
    ],
    { maxBuffer: 32 * 1024 * 1024 }
  )

  console.log(
    `[adhoc-sign] ${Arch[context.arch]}: ad-hoc signed ${appPath} with rcodesign ` +
      '(no certificate — Gatekeeper will still require right-click → Open).'
  )
}
