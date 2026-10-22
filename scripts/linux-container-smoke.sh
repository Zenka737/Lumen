#!/usr/bin/env bash
# Installs the Linux packages inside clean distro containers and smoke-launches them under Xvfb.
# Usage: scripts/linux-container-smoke.sh [release-dir] [arch: x64|arm64]   (needs Docker)
set -euo pipefail
REL="$(cd "${1:-release}" && pwd)"
ARCH="${2:-x64}"
case "$ARCH" in x64) DEB=amd64; RPM=x86_64; AI=x86_64;; arm64) DEB=arm64; RPM=aarch64; AI=arm64;; esac
SMOKE='export LUMEN_SMOKE=1 LUMEN_USER_DATA=/tmp/p; xvfb-run -a -s "-screen 0 1440x900x24" "$BIN" --no-sandbox --disable-gpu 2>&1 | tee /tmp/out.txt; grep -q "\[lumen-smoke\] {\"ok\":true" /tmp/out.txt && ! grep -q "\[renderer:error\]" /tmp/out.txt && echo SMOKE_PASS'
run() { echo "=== $1 ($2)"; docker run --rm -v "$REL:/rel:ro" "$1" bash -lc "$3" | tee "/tmp/lumen-$4.log"; grep -q SMOKE_PASS "/tmp/lumen-$4.log"; }

run ubuntu:24.04 deb "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq /rel/Lumen-*-linux-$DEB.deb xvfb xauth >/dev/null && BIN=/opt/Lumen/lumen && test -f /usr/share/applications/lumen.desktop && $SMOKE" ubuntu-deb
run debian:12 deb "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq /rel/Lumen-*-linux-$DEB.deb xvfb xauth >/dev/null && BIN=/opt/Lumen/lumen && $SMOKE" debian-deb
run fedora:41 rpm "dnf install -y -q /rel/Lumen-*-linux-$RPM.rpm xorg-x11-server-Xvfb xorg-x11-xauth which >/dev/null && BIN=/opt/Lumen/lumen && test -f /usr/share/applications/lumen.desktop && $SMOKE" fedora-rpm
run ubuntu:24.04 appimage "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 >/dev/null && cp /rel/Lumen-*-linux-$AI.AppImage /tmp/l.AppImage && chmod +x /tmp/l.AppImage && export APPIMAGE_EXTRACT_AND_RUN=1 && BIN=/tmp/l.AppImage && $SMOKE" ubuntu-appimage
run ubuntu:22.04 targz "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 >/dev/null && mkdir /tmp/l && tar xzf /rel/Lumen-*-linux-$ARCH.tar.gz -C /tmp/l --strip-components=1 && BIN=/tmp/l/lumen && $SMOKE" ubuntu-targz
echo "All Linux container smoke tests passed ($ARCH)"
