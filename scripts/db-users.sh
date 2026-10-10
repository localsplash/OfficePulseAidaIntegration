#!/usr/bin/env bash
# Operator-run provisioning for the platform runtime database, never the PBX.
# Inputs are aida-pbx's DB_* settings. See docs/DB_USERS.md.
set +x
set -euo pipefail

die() { printf '[db-users] %s\n' "$*" >&2; exit 2; }
identifier() {
  [[ $1 =~ ^[A-Za-z0-9_]+$ && ${#1} -le $3 ]] || die "$2 must be a plain identifier (max $3 characters)"
}
port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )) || die 'MySQL port must be 1-65535'; }
# The connection explicitly sets sql_mode before using these literals.
literal() { local value=${1//\\/\\\\}; printf "'%s'" "${value//\'/\'\'}"; }

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
HOST=${MYSQL_ADMIN_HOST:-$DB_HOST}
PORT=${MYSQL_ADMIN_PORT:-${DB_PORT:-3306}}
DATABASE=$DB_NAME
RUNTIME_USER=$DB_USER
ADMIN=${MYSQL_ADMIN_USER:-root}
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD is required}"
identifier "$DATABASE" DB_NAME 64
[[ $DATABASE == aidacalls_db || $DATABASE =~ ^aida_[a-z0-9_]+_test$ ]] || die 'Database must be aidacalls_db or a disposable aida_*_test schema'
identifier "$RUNTIME_USER" DB_USER 32
identifier "$ADMIN" MYSQL_ADMIN_USER 32
port "$PORT"
[[ $RUNTIME_USER != "$ADMIN" ]] || die 'Runtime and admin accounts must be distinct'
case "$RUNTIME_USER" in root|mysql.*) die 'System accounts cannot be application accounts';; esac

# Unlike CREATE DATABASE, database-level GRANT interprets _ and % as wildcards.
# Names currently permit only the former; escape both before interpolation.
GRANT_DATABASE=${DATABASE//_/\\_}
GRANT_DATABASE=${GRANT_DATABASE//%/\\%}
RUNTIME_ACCOUNT="'$RUNTIME_USER'@'%'"

# Passwords are never command-line arguments or output. Binary batch mode
# disables mysql client commands in input. Suppress SQL error text, which can
# include literals; any failure returns nonzero and no success message.
if ! MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP \
  --host="$HOST" --port="$PORT" --user="$ADMIN" --connect-timeout=10 \
  --default-character-set=utf8mb4 --binary-mode --batch --skip-column-names \
  >/dev/null 2>&1 <<SQL
SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';
CREATE DATABASE IF NOT EXISTS \`$DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS $RUNTIME_ACCOUNT IDENTIFIED BY $(literal "$DB_PASSWORD");
ALTER USER $RUNTIME_ACCOUNT IDENTIFIED BY $(literal "$DB_PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $RUNTIME_ACCOUNT;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON \`$GRANT_DATABASE\`.* TO $RUNTIME_ACCOUNT;
SQL
then die 'MySQL provisioning failed; check connectivity/admin privileges. Account changes may be partial; correct the problem and rerun.'
fi
printf '[db-users] %s: runtime DML and migrations on %s\n' "$RUNTIME_USER" "$DATABASE"
