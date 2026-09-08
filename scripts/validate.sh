#!/usr/bin/env bash
# Canonical local development API smoke check; never changes the external PBX.
set -euo pipefail
HTTP_URL="${HTTP_URL:-http://127.0.0.1:8085}"
curl -fsS "$HTTP_URL/healthz"
curl -fsS "$HTTP_URL/readyz"
