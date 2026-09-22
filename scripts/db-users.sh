#!/usr/bin/env bash
# Operator-run provisioning for the platform runtime database, never the PBX.
# Inputs are the same resolved RUNTIME_MYSQL_* values OfficePulse reads and
# AidaAdmin's OFFICEPULSE_RUNTIME_DATABASE_URL. See docs/DB_USERS.md.
set +x
set -euo pipefail

die() { printf '[db-users] %s\n' "$*" >&2; exit 2; }
identifier() {
  [[ $1 =~ ^[A-Za-z0-9_]+$ && ${#1} -le $3 ]] || die "$2 must be a plain identifier (max $3 characters)"
}
port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )) || die 'MySQL port must be 1-65535'; }
# Assign through printf -v: command substitution would remove trailing newlines
# from percent-encoded passwords. Never evaluate decoded input as shell syntax.
urldecode() {
  local encoded=$1 decoded='' prefix rest byte character
  while [[ $encoded == *%* ]]; do
    prefix=${encoded%%\%*}; rest=${encoded#*%}
    [[ $rest =~ ^[0-9A-Fa-f]{2} ]] || die 'Reader URL contains invalid percent encoding'
    byte=${rest:0:2}
    [[ $byte != 00 ]] || die 'Reader URL cannot contain NUL bytes'
    printf -v character '%b' "\\x$byte"
    decoded+="$prefix$character"
    encoded=${rest:2}
  done
  printf -v "$2" '%s' "$decoded$encoded"
}
# The connection explicitly sets sql_mode before using these literals.
literal() { local value=${1//\\/\\\\}; printf "'%s'" "${value//\'/\'\'}"; }

HOST=${DB_HOST:-${RUNTIME_MYSQL_HOST:?RUNTIME_MYSQL_HOST is required}}
PORT=${DB_PORT:-${RUNTIME_MYSQL_PORT:-3306}}
DATABASE=${RUNTIME_MYSQL_DATABASE:-aidacalls_db}
RUNTIME_USER=${RUNTIME_MYSQL_USER:-aida_runtime}
: "${RUNTIME_MYSQL_PASSWORD:?RUNTIME_MYSQL_PASSWORD is required}"
: "${OFFICEPULSE_RUNTIME_DATABASE_URL:?OFFICEPULSE_RUNTIME_DATABASE_URL is required}"
ADMIN=${MYSQL_ADMIN_USER:-root}
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD is required}"
identifier "$DATABASE" RUNTIME_MYSQL_DATABASE 64
[[ $DATABASE == aidacalls_db || $DATABASE =~ ^aida_[a-z0-9_]+_test$ ]] || die 'Database must be aidacalls_db or a disposable aida_*_test schema'
identifier "$RUNTIME_USER" RUNTIME_MYSQL_USER 32
identifier "$ADMIN" MYSQL_ADMIN_USER 32
port "$PORT"

# User/password are percent-decoded, but the database path is not, matching
# AidaAdmin's runtime-db.ts. Reader host may differ (e.g. a local SSH tunnel).
re='^mysql://([^:@/?#]+):([^@/?#]*)@(\[[0-9A-Fa-f:.]+\]|[^:/?#]+)(:([0-9]+))?/([^/?#]+)([?#].*)?$'
[[ $OFFICEPULSE_RUNTIME_DATABASE_URL =~ $re ]] || die 'Reader URL must be mysql://user:password@host[:port]/database'
parts=("${BASH_REMATCH[@]}")
urldecode "${parts[1]}" READER_USER
urldecode "${parts[2]}" READER_PASSWORD
identifier "$READER_USER" 'Reader user' 32
identifier "${parts[6]}" 'Reader database' 64
[[ -z ${parts[5]} ]] || port "${parts[5]}"
[[ -n $READER_PASSWORD ]] || die 'Reader URL must include a password'
[[ ${parts[6]} == "$DATABASE" ]] || die 'Reader URL and RUNTIME_MYSQL_DATABASE must name the same database'
[[ $RUNTIME_USER != "$READER_USER" && $RUNTIME_USER != "$ADMIN" && $READER_USER != "$ADMIN" ]] || die 'Runtime, reader and admin accounts must be distinct'
case "$RUNTIME_USER:$READER_USER" in root:*|*:root|mysql.*) die 'System accounts cannot be application accounts';; esac

# Unlike CREATE DATABASE, database-level GRANT interprets _ and % as wildcards.
# Names currently permit only the former; escape both before interpolation.
GRANT_DATABASE=${DATABASE//_/\\_}
GRANT_DATABASE=${GRANT_DATABASE//%/\\%}
RUNTIME_ACCOUNT="'$RUNTIME_USER'@'%'"
READER_ACCOUNT="'$READER_USER'@'%'"

# Passwords are never command-line arguments or output. Binary batch mode
# disables mysql client commands in input. Suppress SQL error text, which can
# include literals; any failure returns nonzero and no success message.
if ! MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP \
  --host="$HOST" --port="$PORT" --user="$ADMIN" --connect-timeout=10 \
  --default-character-set=utf8mb4 --binary-mode --batch --skip-column-names \
  >/dev/null 2>&1 <<SQL
SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';
CREATE DATABASE IF NOT EXISTS \`$DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS $RUNTIME_ACCOUNT IDENTIFIED BY $(literal "$RUNTIME_MYSQL_PASSWORD");
ALTER USER $RUNTIME_ACCOUNT IDENTIFIED BY $(literal "$RUNTIME_MYSQL_PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $RUNTIME_ACCOUNT;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON \`$GRANT_DATABASE\`.* TO $RUNTIME_ACCOUNT;
CREATE USER IF NOT EXISTS $READER_ACCOUNT IDENTIFIED BY $(literal "$READER_PASSWORD");
ALTER USER $READER_ACCOUNT IDENTIFIED BY $(literal "$READER_PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $READER_ACCOUNT;
GRANT SELECT ON \`$GRANT_DATABASE\`.* TO $READER_ACCOUNT;
SQL
then die 'MySQL provisioning failed; check connectivity/admin privileges. Account changes may be partial; correct the problem and rerun.'
fi
printf '[db-users] %s: runtime DML and migrations on %s; %s: SELECT only\n' "$RUNTIME_USER" "$DATABASE" "$READER_USER"
