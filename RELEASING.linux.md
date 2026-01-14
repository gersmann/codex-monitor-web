# Releasing CodexMonitor (Linux/AppImage)

This is a copy/paste friendly script-style guide. It must be run on Linux and
produces an AppImage for the current machine architecture (x86_64 or
arm64/aarch64).

Prerequisites (examples):

- Ubuntu/Debian: `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2`
- Arch: `sudo pacman -S --needed webkit2gtk gtk3 libayatana-appindicator librsvg patchelf fuse2`

Notes:

- AppImage bundling uses the current OS and arch (no cross-compile in this flow).
- On Arch, AppImage bundling can fail while stripping; `npm run build:appimage`
  already sets `NO_STRIP=1`.
- If AppImage tooling fails to execute because of FUSE, try:
  `APPIMAGE_EXTRACT_AND_RUN=1 npm run build:appimage`.

```bash
set -euo pipefail

# --- Set versions ---
# Update these two values each release.
RELEASE_VERSION="0.6.1"
PREV_VERSION="0.5.1"

# --- Update version fields (manual check afterwards) ---
perl -pi -e "s/\"version\": \"[^\"]+\"/\"version\": \"${RELEASE_VERSION}\"/" package.json
perl -pi -e "s/\"version\": \"[^\"]+\"/\"version\": \"${RELEASE_VERSION}\"/" src-tauri/tauri.conf.json
npm install

# --- Commit + push version bump ---
git add package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to ${RELEASE_VERSION}"
git push origin main

# --- Build AppImage ---
npm run build:appimage

# --- Collect artifact ---
ARCH="$(uname -m)"
APPIMAGE_DIR="src-tauri/target/release/bundle/appimage"
APPIMAGE_FILE="$(ls "${APPIMAGE_DIR}"/*.AppImage | head -n 1)"
mkdir -p release-artifacts
cp "${APPIMAGE_FILE}" "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage"

# Optional: checksum
sha256sum "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage" \
  > "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage.sha256"

# --- Changelog (for release notes) ---
git log --name-only --pretty=format:"%h %s" v${PREV_VERSION}..v${RELEASE_VERSION}

# --- Tag ---
git tag v${RELEASE_VERSION}
git push origin v${RELEASE_VERSION}

# --- Create GitHub release with artifact ---
gh release create v${RELEASE_VERSION} \
  --title "v${RELEASE_VERSION}" \
  --notes "- Short update notes" \
  "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage" \
  "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage.sha256"

# --- If you need to update assets later ---
gh release upload v${RELEASE_VERSION} \
  "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage" \
  "release-artifacts/CodexMonitor_${RELEASE_VERSION}_${ARCH}.AppImage.sha256" \
  --clobber
```
