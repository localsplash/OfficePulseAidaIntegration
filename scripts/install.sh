#!/usr/bin/env bash
# Install/upgrade the integration service on LSAidaOffice01 (systemd).
#
# Usage: scripts/install.sh [INSTALL_DIR]
#   INSTALL_DIR default /opt/aida-integration
#
# Expects: node >= 22 on the host, /etc/aida-integration/env populated
# (see README configuration table), deploy/sql/schema.sql AND
# deploy/sql/runtime-schema.sql applied (the latter creates the
# `aida_officepulse` database this service owns), and
# the Asterisk templates under asterisk/ installed on the OfficePulse
# host. Keeps the previous release for scripts/rollback.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_DIR="${1:-/opt/aida-integration}"
STAMP=$(date +%Y%m%d%H%M%S)

echo "building…"
npm ci
npm run verify
npm run build

if [ -d "$INSTALL_DIR/dist" ]; then
  cp -a "$INSTALL_DIR" "${INSTALL_DIR}.prev.${STAMP}"
  echo "previous release kept at ${INSTALL_DIR}.prev.${STAMP}"
fi

mkdir -p "$INSTALL_DIR"
rsync -a --delete dist "$INSTALL_DIR/"
rsync -a package.json package-lock.json "$INSTALL_DIR/"
(cd "$INSTALL_DIR" && npm ci --omit=dev)

id aida >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin aida
install -m 0644 deploy/systemd/aida-integration.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable aida-integration
systemctl restart aida-integration

echo "installed; run scripts/validate.sh to smoke-test"
