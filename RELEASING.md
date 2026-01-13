# Releasing CodexMonitor (macOS)

This guide is written for fresh agents and humans. It assumes the machine has
no access to private keys by default. Signing and notarization require the
Developer ID certificate and notarization credentials, which must be provided
by a human.

## Prereqs (Human-Provided)

- Apple Developer account with Team ID.
- Developer ID Application certificate installed in Keychain.
- Notarization credentials for `notarytool`:
  - Apple ID + app-specific password, or
  - App Store Connect API key.

## Versioning

Read the current version and decide the next release tag:

```bash
cat src-tauri/tauri.conf.json
cat package.json
```

Bump both to the release version before building. After the release is published, bump both to the next minor.

## Build

```bash
npm install
npm run tauri build
```

The app bundle is produced at:

```
src-tauri/target/release/bundle/macos/CodexMonitor.app
```

## Bundle OpenSSL (Required for distribution)

The app links to OpenSSL. Bundle and re-sign the OpenSSL dylibs:

```bash
CODESIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/macos-fix-openssl.sh
```

## Sign + Notarize + Staple (Human Step)

1) Confirm signing identity (from Keychain):

```bash
security find-identity -v -p codesigning
```

2) Zip the app:

```bash
ditto -c -k --keepParent \
  src-tauri/target/release/bundle/macos/CodexMonitor.app \
  CodexMonitor.zip
```

3) Store notary credentials (one-time per machine):

```bash
xcrun notarytool store-credentials codexmonitor-notary \
  --apple-id "you@apple.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"
```

If the profile already exists in Keychain, reuse it:

```bash
--keychain-profile "codexmonitor-notary"
```

Validate the profile (works even if listing is unsupported):

```bash
xcrun notarytool history --keychain-profile "codexmonitor-notary"
```

4) Submit for notarization and wait:

```bash
xcrun notarytool submit CodexMonitor.zip \
  --keychain-profile "codexmonitor-notary" \
  --wait
```

5) Staple the app:

```bash
xcrun stapler staple \
  src-tauri/target/release/bundle/macos/CodexMonitor.app
```

## Package Release Artifacts

Note: Tauri's DMG bundling can fail if the generated `bundle_dmg.sh` script
is invoked without arguments. The manual packaging flow below is the fallback
and is the expected path if that happens.

```bash
mkdir -p release-artifacts release-artifacts/dmg-root
rm -rf release-artifacts/dmg-root/CodexMonitor.app
ditto src-tauri/target/release/bundle/macos/CodexMonitor.app \
  release-artifacts/dmg-root/CodexMonitor.app

ditto -c -k --keepParent \
  src-tauri/target/release/bundle/macos/CodexMonitor.app \
  release-artifacts/CodexMonitor.zip

hdiutil create -volname "CodexMonitor" \
  -srcfolder release-artifacts/dmg-root \
  -ov -format UDZO \
  release-artifacts/CodexMonitor_<RELEASE_VERSION>_aarch64.dmg
```

## Generate Changelog (from git log)

Create release notes from the tag range using plain git log:

```bash
git log --name-only --pretty=format:"%h %s" v<PREV_VERSION>..v<RELEASE_VERSION>
```

Summarize user-facing changes into short bullet points and use them in the GitHub release notes.

## GitHub Release (with gh)

```bash
git tag v<RELEASE_VERSION>
git push origin v<RELEASE_VERSION>

gh release create v<RELEASE_VERSION> \
  --title "v<RELEASE_VERSION>" \
  --notes "Signed + notarized macOS release." \
  release-artifacts/CodexMonitor.zip \
  release-artifacts/CodexMonitor_<RELEASE_VERSION>_aarch64.dmg
```

## Notes

- Signing/notarization cannot be performed without the Developer ID certificate
  and notarization credentials.
- If the app fails to launch on another machine, verify OpenSSL is bundled:
  `otool -L .../CodexMonitor.app/Contents/MacOS/codex-monitor` should show
  `@rpath/libssl.3.dylib` and `@rpath/libcrypto.3.dylib`.
