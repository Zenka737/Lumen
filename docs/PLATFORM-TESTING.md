# Platform testing matrix

Status as of 2026-10-23, Lumen 0.1.0-alpha, Electron 45, electron-builder 26.

Everything below is exercised by `.github/workflows/desktop.yml` on every push and pull request. A release (tag `v*`) is published only when all of it is green.

## CI matrix

| Runner | What runs |
|---|---|
| `macos-latest` (Apple Silicon) | typecheck, unit tests, web build, arm64 / x64 / universal builds (`.dmg`, `.zip`), smoke + e2e of the arm64 app, `.dmg` mount + smoke, x64 under Rosetta (non-blocking: Rosetta is unreliable inside the hosted VM) |
| `windows-latest` | x64 + arm64 builds (NSIS, portable), smoke + e2e of the unpacked app, silent install of the NSIS setup + smoke of the installed app |
| `ubuntu-latest` | x64 + arm64 builds (AppImage, deb, rpm, tar.gz), xvfb smoke + e2e, install in Ubuntu 24.04, Debian 12, Fedora 41 (+ Ubuntu 22.04 tar.gz) containers |
| `ubuntu-24.04-arm` | the same container install tests for the arm64 packages |
| `windows-11-arm` | smoke of the arm64 build |

Smoke = launch, load the editor, no renderer errors (`scripts/smoke-packaged.mjs`). E2E (`scripts/verify-electron.mjs`) = open an image from the command line, draw, export through the native menu, save a `.lumen` project, shapes / layer styles / animation sanity check, quit guard, no console errors. On Windows the Playwright Electron handshake stalls on the hosted runners, so the e2e falls back to driving the same window over CDP (native menu and quit-guard steps are skipped there).

## What CI has found and fixed so far
- macOS: empty `CSC_LINK` secret broke electron-builder ("not a file") → signing variables are only exported when the secret exists.
- Linux: the deb dependency `libasound2 | libasound2t64` resolved to a stub on Ubuntu 24.04 → `libasound2t64 | libasound2`; rpm gained `alsa-lib`; the arm64 AppImage runtime needs `libz.so` in a bare container.
- All: hosted runners have no GPU → smoke / e2e run with `LUMEN_DISABLE_GPU=1`.

## Hardware and OS coverage

| | Verified | How |
|---|---|---|
| macOS 26 on Apple Silicon (M4) | yes | local development machine, packaged app |
| macOS (hosted runner version) arm64 | yes | CI |
| macOS x64 | partly | Rosetta 2 on the M4 (local); on CI Rosetta is non-blocking |
| Windows x64 (hosted Server image) | yes | CI, incl. real silent install |
| Windows arm64 | smoke only | CI `windows-11-arm` |
| Ubuntu 24.04 / 22.04, Debian 12, Fedora 41, x64 + arm64 | yes | CI containers (Xvfb, no real desktop) |

## Not verified anywhere yet
- Real Intel Macs, older macOS versions (13–15), macOS 26.x other than the dev machine.
- Windows 10, real Windows 11 hardware, multi-monitor / mixed-DPI.
- GNOME / KDE / XFCE integration, Wayland, file associations on Windows and Linux.
- Signed / notarized builds (no certificates are configured); auto-update (scaffold only, disabled without a feed).
- The release job (tag `v*` → GitHub Release + download site) has not run yet; try it on a test tag before the first real release.
- macOS "liquid glass" (vibrancy + backdrop blur) is only checked on the dev machine; Windows / Linux get the blurred panels without a see-through window.

## How to reproduce locally
```
npm run app:dev                         # dev shell with HMR
npm run dist:mac | dist:win | dist:linux | dist:all
node scripts/smoke-packaged.mjs [exe]   # launch the packaged app, assert the editor loaded
node scripts/verify-electron.mjs [exe]  # e2e: open, draw, export, save, features, quit guard
VERIFY_CDP=1 node scripts/verify-electron.mjs [exe]   # same through CDP (what Windows CI uses)
bash scripts/linux-container-smoke.sh release x64     # needs Docker
```
