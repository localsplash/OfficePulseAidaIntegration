#!/usr/bin/env bash
# Deploy validated prompt audio to the Asterisk sounds directory.
#
# Validation gates deployment: a missing or corrupt prompt aborts before
# anything is copied and before any Asterisk reload. The previous prompt
# set is kept for scripts/rollback.sh.
#
# Usage: scripts/deploy-prompts.sh [SOUNDS_DIR] [OWNER]
#   SOUNDS_DIR default /var/lib/asterisk/sounds/aida
#   OWNER      default asterisk:asterisk
set -euo pipefail
cd "$(dirname "$0")/.."

SOUNDS_DIR="${1:-/var/lib/asterisk/sounds/aida}"
OWNER="${2:-asterisk:asterisk}"

echo "validating prompt manifest…"
npm run --silent validate:prompts

STAMP=$(date +%Y%m%d%H%M%S)
if [ -d "$SOUNDS_DIR" ]; then
  cp -a "$SOUNDS_DIR" "${SOUNDS_DIR}.prev.${STAMP}"
  echo "previous prompts kept at ${SOUNDS_DIR}.prev.${STAMP}"
fi
mkdir -p "$SOUNDS_DIR"
install -m 0644 prompts/audio/*.ulaw "$SOUNDS_DIR/"
chown -R "$OWNER" "$SOUNDS_DIR"
echo "prompts deployed to $SOUNDS_DIR (no reload required for sound files)"
