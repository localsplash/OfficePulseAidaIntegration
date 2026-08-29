#!/usr/bin/env bash
# Post-install validation for LSAidaOffice01.
#
# Checks, in order:
#  1. service process is healthy (/healthz) and dependencies are ready
#     (/readyz reports ari + mysql + aidacontrol),
#  2. prompt manifest validates against the deployed sound files,
#  3. the Asterisk include and Stasis app are visible from the
#     OfficePulse host (run the printed commands there).
set -euo pipefail

HTTP_URL="${HTTP_URL:-http://127.0.0.1:8085}"

echo "== healthz =="
curl -fsS "$HTTP_URL/healthz" && echo

echo "== readyz =="
curl -fsS "$HTTP_URL/readyz" && echo || {
  echo "readyz reports degraded dependencies (see components above)" >&2
  exit 1
}

echo "== prompts =="
SOUNDS_DIR="${SOUNDS_DIR:-/var/lib/asterisk/sounds/aida}"
if [ -d "$SOUNDS_DIR" ]; then
  npm run --silent validate:prompts || exit 1
else
  echo "NOTE: $SOUNDS_DIR not found on this host — validate prompts on the OfficePulse host"
fi

cat <<'EOF'
== manual checks on the OfficePulse (Asterisk) host ==
  asterisk -rx 'dialplan show aida-post-bootstrap'   # include installed
  asterisk -rx 'ari show apps'                       # 'aida' registered
  asterisk -rx 'pjsip show endpoints'                # provisioned endpoints
Then place a disposable test call to a provisioned DID and verify:
  disclosure plays first, then FastAGI runs, and X-Aida-* headers reach
  the LiveKit trunk (pjsip set logger on).
EOF
