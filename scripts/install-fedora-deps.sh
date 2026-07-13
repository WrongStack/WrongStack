#!/usr/bin/env bash
# WrongStack Fedora 43 system dependencies installer
#
# Installs the native libraries required by WrongStack on Fedora 43
# with Mutter (Wayland). Covers:
#   - Electron / Chromium GPU dependencies (gbm, libdrm, wayland-egl)
#   - Playwright / Chromium headless deps (nss, cups, libdrm)
#   - node-pty native build dependencies
#   - Optional: better-sqlite3 build tools
#
# Usage: sudo bash scripts/install-fedora-deps.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}ℹ${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
fail()  { echo -e "${RED}✗${NC} $*"; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "This script must be run as root (sudo)."
fi

echo -e "\n${BOLD}${CYAN}WrongStack${NC} — Fedora 43 system dependencies"
echo -e "${DIM}Wayland / Mutter / Electron / Playwright / node-pty${NC}\n"

# ── Chromium / Electron base deps ──────────────────────────────────
# Required by Electron 43+ and Playwright's bundled Chromium on Linux.
# Without these, Electron windows render blank and Playwright headless
# crashes with "error while loading shared libraries."
info "Installing Chromium/Electron runtime dependencies..."
dnf install -y \
  nss \
  nspr \
  cups-libs \
  libdrm \
  mesa-dri-drivers \
  mesa-libgbm \
  libxkbcommon \
  atk \
  at-spi2-atk \
  gtk3 \
  pango \
  cairo \
  libxcb \
  libX11 \
  libXcomposite \
  libXdamage \
  libXext \
  libXfixes \
  libXrandr \
  libXrender \
  libXcursor \
  libXinerama \
  libXi \
  alsa-lib \
  dbus-libs
ok "Chromium/Electron deps installed"

# ── Wayland native deps ────────────────────────────────────────────
# Mutter requires mesa-libEGL and wayland-egl for GPU-accelerated
# compositing. When --disable-gpu is used these aren't strictly needed,
# but they prevent "EGL not available" spam in Electron logs.
info "Installing Wayland/Mutter GPU dependencies..."
dnf install -y \
  mesa-libEGL \
  libglvnd-egl \
  wayland-devel
ok "Wayland GPU deps installed"

# ── Playwright additional deps ─────────────────────────────────────
# Playwright's Chromium needs extra libs that Electron doesn't bundle.
info "Installing Playwright headless dependencies..."
dnf install -y \
  libXss \
  libXtst \
  alsa-plugins-pulseaudio
ok "Playwright deps installed"

# ── Native module build tools ──────────────────────────────────────
# node-pty and better-sqlite3 both need a C++ compiler and Python for
# prebuild-install / node-gyp on systems without prebuilts.
info "Installing native module build dependencies..."
dnf install -y \
  gcc-c++ \
  make \
  python3
ok "Build tools installed"

echo ""
info "All Fedora 43 dependencies installed."
echo "  Run: pnpm install"
echo "  Then: pnpm run check:browser -- --install --with-deps"
echo "  Then: node scripts/check-node-pty.mjs"
echo ""
