# Platform testing matrix

Status as of 2026-10-22, Lumen 0.1.0-alpha, Electron 45.0.0, electron-builder 26.15.3.
Build host: one Mac, Apple Silicon (arm64), macOS 26 (Darwin 25.6). No Docker, no Wine, no VMs available.

Legend: **Verified** = actually executed and checked here. **Built only** = artifact produced, never launched.
**CI** = covered by `.github/workflows/desktop.yml`, but that workflow has **not been run yet** (no GitHub repo/run exists).

## What was built on this Mac (cross-built where needed)

| Target | Artifacts | Built here |
|---|---|---|
| macOS arm64 / x64 / universal | `.dmg`, `.zip` | yes (unsigned) |
| Windows x64 / arm64 | NSIS `-setup.exe` per arch + combined x64+arm64 installer, x64 portable `.exe` | yes, cross-built without Wine (unsigned) |
| Linux x64 / arm64 | AppImage, `.deb`, `.rpm` (needs `brew install rpm`), `.tar.gz` | yes, cross-built |

## Verification matrix

| Platform / package | Launch | Load editor | Open image | Draw | Export | Save .lumen | Quit guard | No console errors | Where |
|---|---|---|---|---|---|---|---|---|---|
| Electron dev (`electron .`), macOS arm64 | Verified | Verified | Verified (CLI arg) | Verified | Verified (via native menu → PNG) | Verified | Verified (prompt shown when dirty) | Verified | this Mac |
| Packaged `mac-arm64/Lumen.app` | Verified | Verified | Verified (CLI arg, second-instance, Finder `open -a` → `open-file`) | Verified | Verified | Verified | Verified | Verified | this Mac |
| `.dmg` arm64 (mounted, app launched from it) | Verified | Verified | – | – | – | – | – | Verified (smoke) | this Mac |
| Packaged `mac-universal/Lumen.app` | Verified | Verified | – | – | – | – | – | Verified (smoke) | this Mac (arm64 slice) |
| Packaged `mac/Lumen.app` (x64) | Verified under **Rosetta 2** only | Verified | – | – | – | – | – | Verified (smoke) | this Mac — not on a real Intel Mac |
| Windows x64 NSIS / portable | **Not verified here** | | | | | | | | CI: silent install + smoke + Playwright e2e on `windows-latest` |
| Windows arm64 | **Not verified here** | | | | | | | | CI: smoke on `windows-11-arm` |
| Linux x64 AppImage / deb / rpm / tar.gz | **Not verified here** (no Docker) | | | | | | | | CI: xvfb smoke + e2e on `ubuntu-latest`, install in Ubuntu 24.04, Debian 12, Fedora 41, Ubuntu 22.04 containers |
| Linux arm64 packages | **Not verified here** | | | | | | | | CI: same container tests on `ubuntu-24.04-arm` |

Static checks done on cross-built artifacts (not runtime tests):
- `.deb` (amd64) unpacked: `/opt/Lumen/lumen`, `usr/share/applications/lumen.desktop` (Categories Graphics, MimeType png/jpeg/webp/x-lumen-project), hicolor icons 16–1024, `usr/share/mime/packages/lumen.xml`, postinst handles chrome-sandbox + AppArmor (Ubuntu 24.04+).
- Windows `Lumen.exe` has Lumen version resources (product name / description) embedded.
- macOS `Info.plist`: bundle id `app.lumen.editor`, category graphics-design, document types png/jpg/webp/lumen.

## Not verified anywhere yet (be aware)
- Any Windows or Linux runtime behaviour, file associations on those OSes, desktop-environment integration (GNOME/KDE/XFCE), Wayland.
- Real Intel Mac hardware; macOS versions other than 26.
- Signed/notarized builds (no certificates were used).
- Auto-update (scaffold only; disabled without a feed).
- Lighthouse audit of the website (only manual checks: no console errors, no horizontal scroll at 390 px, keyboard-operable tabs).

## How to reproduce
```
npm run app:dev                         # dev shell with HMR
npm run dist:mac | dist:win | dist:linux | dist:all
node scripts/smoke-packaged.mjs [exe]   # launch packaged app headless-ish, assert editor loaded
node scripts/verify-electron.mjs [exe]  # Playwright e2e: open, draw, export, save, quit guard
bash scripts/linux-container-smoke.sh release x64   # needs Docker
```
