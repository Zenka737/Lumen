# Lumen desktop app

The desktop app is the unmodified web build (`dist/`) inside an Electron shell (`electron/`).
The web version keeps working on its own; desktop extras are detected via `window.lumenDesktop`.

## Architecture
- `electron/main.cjs` — serves `dist/` from the privileged `app://lumen/` scheme with a strict CSP, blocks every
  non-local request, contextIsolation + sandbox, single instance, native menus, Open dialog, native Save dialogs
  (the app's downloads become Save-As dialogs), file opening (CLI arg, `second-instance`, macOS `open-file` /
  dock drop), window-state persistence, unsaved-changes guard (`will-prevent-unload`), renderer crash reload,
  opt-in auto-update.
- `electron/preload.cjs` — tiny bridge: `lumenDesktop.{platform, openDialog, onOpenFile, ready}`.

Env switches: `LUMEN_UPDATE_URL` (generic update feed), `LUMEN_DISABLE_GPU=1`, `LUMEN_USER_DATA` (profile dir),
`LUMEN_SMOKE=1` (load, report, exit), `LUMEN_SAVE_DIR` (non-interactive saves, tests), `LUMEN_DEVTOOLS=1`.

## Build
| Command | Output (release/) |
|---|---|
| `npm run dist:mac` | dmg + zip for arm64, x64, universal |
| `npm run dist:win` | NSIS installers (x64, arm64, combined), portable x64 |
| `npm run dist:linux` | AppImage, deb, rpm, tar.gz for x64 and arm64 (rpm needs `rpmbuild`: `brew install rpm` / `apt install rpm`) |
| `npm run dist:all` | everything (works from macOS, Wine not required) |
| `npm run icons` | regenerate `build/icon.{png,icns,ico,svg}` and `build/icons/*` |
| `npm run releases` | `website/releases.json` + `release/SHA256SUMS.txt` |

## Code signing (optional — unsigned builds work out of the box)
- Unsigned mac build locally: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac`.
- macOS signing: `CSC_LINK` (base64 .p12 or path), `CSC_KEY_PASSWORD`.
  Notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` and add `-c.mac.notarize=true` (CI does this automatically when `APPLE_ID` exists).
- Windows signing: `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` (or `CSC_LINK`/`CSC_KEY_PASSWORD`).
- Put these into GitHub repository secrets; the workflow passes them through.

Unsigned consequences: macOS Gatekeeper requires right-click → Open (or `xattr -dr com.apple.quarantine`);
Windows SmartScreen shows "More info → Run anyway". The website explains both.

## Auto-update
Off by default. Enable either with `LUMEN_UPDATE_URL=<generic feed>` at runtime, or by setting `build.publish`
(e.g. GitHub provider) so electron-builder writes `app-update.yml` into the package.

## Release flow
Push a tag `vX.Y.Z` (matching `package.json` version) → CI builds and smoke-tests all platforms → GitHub Release with
all installers, `SHA256SUMS.txt`, `releases.json` → website deployed to GitHub Pages.
Set `homepage` in package.json (or `GITHUB_REPOSITORY`/`RELEASE_BASE_URL`) so download links point to the real repo —
the current `lumen-editor/lumen` is a placeholder.
