#!/usr/bin/env bash
# Roll back to the previous installed release and/or prompt set.
#
# Usage:
#   scripts/rollback.sh service [INSTALL_DIR]   # restore newest .prev release
#   scripts/rollback.sh prompts [SOUNDS_DIR]    # restore newest .prev prompts
set -euo pipefail

MODE="${1:-service}"

restore_latest_prev() {
  local target="$1"
  local prev
  prev=$(ls -d "${target}".prev.* 2>/dev/null | sort | tail -1 || true)
  if [ -z "$prev" ]; then
    echo "no previous version of $target found" >&2
    exit 1
  fi
  rm -rf "${target}.rollback-tmp"
  mv "$target" "${target}.rollback-tmp"
  mv "$prev" "$target"
  rm -rf "${target}.rollback-tmp"
  echo "restored $target from $prev"
}

case "$MODE" in
  service)
    INSTALL_DIR="${2:-/opt/aida-integration}"
    restore_latest_prev "$INSTALL_DIR"
    systemctl restart aida-integration
    ;;
  prompts)
    SOUNDS_DIR="${2:-/var/lib/asterisk/sounds/aida}"
    restore_latest_prev "$SOUNDS_DIR"
    ;;
  *)
    echo "usage: rollback.sh service|prompts [DIR]" >&2
    exit 2
    ;;
esac
