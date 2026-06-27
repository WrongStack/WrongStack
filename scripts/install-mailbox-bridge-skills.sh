#!/usr/bin/env bash
#
# Install the wrongstack-mailbox skill into a target directory so an
# external agent (e.g. Claude Code, Aider) can read it.
#
# The skill is bundled with @wrongstack/core at:
#   packages/core/skills/wrongstack-mailbox/SKILL.md
#
# This script copies that file into the target directory under
#   <target>/wrongstack-mailbox/SKILL.md
#
# Usage:
#   bash scripts/install-mailbox-bridge-skills.sh                # install to ~/.claude/skills/
#   bash scripts/install-mailbox-bridge-skills.sh ~/.claude/skills # explicit target
#   bash scripts/install-mailbox-bridge-skills.sh /path/to/project/.agent/skills
#
# Idempotent — re-running overwrites an existing copy with the latest bundled version.
# Exit code 0 on success, 1 on any error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${REPO_ROOT}/packages/core/skills/wrongstack-mailbox/SKILL.md"

if [[ ! -f "${SOURCE}" ]]; then
  echo "error: source skill not found at ${SOURCE}" >&2
  echo "       Are you running this from a complete WrongStack checkout?" >&2
  exit 1
fi

# Resolve target — default to ~/.claude/skills
TARGET="${1:-${HOME}/.claude/skills}"

# If TARGET is a relative path, resolve it relative to the caller's cwd.
# Resolve any ~ expansion explicitly.
TARGET="${TARGET/#\~/${HOME}}"

if [[ ! -d "${TARGET}" ]]; then
  echo "error: target directory does not exist: ${TARGET}" >&2
  echo "       Create it first (e.g. mkdir -p ${TARGET})" >&2
  exit 1
fi

DEST_DIR="${TARGET}/wrongstack-mailbox"
DEST_FILE="${DEST_DIR}/SKILL.md"

mkdir -p "${DEST_DIR}"
cp -f "${SOURCE}" "${DEST_FILE}"

echo "Installed wrongstack-mailbox skill → ${DEST_FILE}"
echo
echo "Next steps for the external agent:"
echo "  1. Start the bridge in the WrongStack project:"
echo "       wstack mailbox serve"
echo "  2. Copy the printed URL and token into the agent's environment:"
echo "       WRONGSTACK_MAILBOX_URL=http://127.0.0.1:<port>"
echo "       WRONGSTACK_MAILBOX_TOKEN=<token>"
echo "  3. Ask the agent to read the project mailbox. The wrongstack-mailbox"
echo "     skill (now at ${DEST_FILE}) tells it how to talk to the bridge."