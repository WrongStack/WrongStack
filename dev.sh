#!/bin/bash
# WrongStack Development Environment
# Usage: ./dev.sh (or ./dev.sh --bg for background)

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBSOCKET_PORT=3457
WEBUI_PORT=3456
EMBEDDED_WEBUI_PORT=3458

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     WrongStack Dev Environment          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# Check if bun is available
if ! command -v bun &> /dev/null; then
    echo -e "${YELLOW}Error: bun not found. Please install it first:${NC}"
    echo "  https://bun.sh/docs/installation"
    exit 1
fi

# Parse arguments
BACKGROUND=false
if [[ "$1" == "--bg" || "$1" == "-b" ]]; then
    BACKGROUND=true
fi

cd "$SCRIPT_DIR"

echo -e "${GREEN}[1/3]${NC} Installing dependencies..."
# --ignore-scripts, then rebuild an explicit list. Every one of CI's installs
# does this; the dev entrypoint was the one path that let an arbitrary
# dependency's install lifecycle run, which is the machine where a compromised
# postinstall would find real credentials. The list matches
# `bun rebuild` in .github/workflows/ci.yml and `allowBuilds` in
# package.json trustedDependencies — keep the three in step.
bun install --ignore-scripts --silent 2>/dev/null || bun install --ignore-scripts
bun run setup:native

echo -e "${GREEN}[2/3]${NC} Building packages..."
bun scripts/build.mjs --target @wrongstack/core --target @wrongstack/providers --target @wrongstack/tools 2>/dev/null || true

echo ""
echo -e "${CYAN}Starting services:${NC}"
echo -e "  ${YELLOW}WebUI${NC}     → http://localhost:$WEBUI_PORT"
echo -e "  ${YELLOW}WebSocket${NC} → ws://localhost:$WEBSOCKET_PORT"
echo ""

if [[ "$BACKGROUND" == "true" ]]; then
    echo -e "${GREEN}[3/3]${NC} Starting CLI + WebSocket server in background..."
    bun packages/cli/dist/index.js --webui --ws-port $WEBSOCKET_PORT --webui-port $EMBEDDED_WEBUI_PORT &
    CLI_PID=$!

    echo -e "${GREEN}[3/3]${NC} Starting WebUI (Vite) in background..."
    cd packages/webui && bun run dev &
    WEBUI_PID=$!

    echo ""
    echo -e "${GREEN}✓ All services started in background${NC}"
    echo -e "  CLI PID:      $CLI_PID"
    echo -e "  WebUI PID:    $WEBUI_PID"
    echo ""
    echo "To stop: kill $CLI_PID $WEBUI_PID"
    echo "To view logs: see terminal output"
else
    echo -e "${GREEN}[3/3]${NC} Starting CLI + WebSocket server (Ctrl+C to stop)..."
    echo ""

    # Function to cleanup on exit
    cleanup() {
        echo ""
        echo -e "${YELLOW}Shutting down...${NC}"
        kill $(jobs -p) 2>/dev/null || true
        exit 0
    }
    trap cleanup SIGINT SIGTERM

    # Start WebSocket server in background (with log prefix)
    bun packages/cli/dist/index.js --webui --ws-port $WEBSOCKET_PORT --webui-port $EMBEDDED_WEBUI_PORT 2>&1 &
    WS_PID=$!
    echo -e "  ${CYAN}WebSocket${NC} started (PID: $WS_PID)"

    # Wait a moment for WebSocket to initialize
    sleep 1

    # Start WebUI (this will block)
    cd packages/webui && bun run dev 2>&1 &
    WEBUI_PID=$!
    echo -e "  ${CYAN}WebUI${NC}     started (PID: $WEBUI_PID)"

    echo ""
    echo -e "${GREEN}✓ All services running${NC}"
    echo ""

    # Wait for any process to exit
    wait
fi
