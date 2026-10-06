#!/usr/bin/env bash
# Canonical local development API smoke check; never changes the external PBX.
set -euo pipefail
HTTP_URL="${HTTP_URL:-http://127.0.0.1:8085}"
curl -fsS "$HTTP_URL/healthz"
curl -fsS "$HTTP_URL/readyz"

if [ -n "${PUBLIC_URL:-}" ]; then
  attach_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "${PUBLIC_URL%/}/v1/handset/attach")
  if [ "$attach_status" != 400 ]; then
    echo "Public handset attach returned $attach_status; expected 400 from the application. Check the nginx handset location." >&2
    exit 1
  fi
fi
