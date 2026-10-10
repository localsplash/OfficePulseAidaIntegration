#!/usr/bin/env bash
# One-time, operator-run rename of the runtime database and its account, from
# aidacalls_db/aida_runtime to aida_pbx_db/aida_pbx_app. Stop the AidaPbx
# service first; afterwards set aida-pbx/DB_NAME and DB_USER to the new names
# and start it (AidaPlatformDB's `install.sh rename-pbx-database` does all of
# this but the stop and start). See docs/DB_USERS.md.
#
# Same server only: tables move with RENAME TABLE, which changes metadata and
# copies no data. The password is kept. Rerunning after success changes
# nothing; swapping FROM_* and TO_* moves everything back.
set +x
set -euo pipefail

die() { printf '[rename-database] %s\n' "$*" >&2; exit 2; }
say() { printf '[rename-database] %s\n' "$*"; }
identifier() {
  [[ $1 =~ ^[A-Za-z0-9_]+$ && ${#1} -le $3 ]] || die "$2 must be a plain identifier (max $3 characters)"
}
runtime_database() { [[ $1 == aida_pbx_db || $1 == aidacalls_db || $1 =~ ^aida_[a-z0-9_]+_test$ ]]; }
port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )) || die 'MySQL port must be 1-65535'; }

FROM_DB=${FROM_DB:-aidacalls_db}
TO_DB=${TO_DB:-aida_pbx_db}
FROM_USER=${FROM_USER:-aida_runtime}
TO_USER=${TO_USER:-aida_pbx_app}
HOST=${MYSQL_ADMIN_HOST:-${DB_HOST:-}}
PORT=${MYSQL_ADMIN_PORT:-${DB_PORT:-3306}}
ADMIN=${MYSQL_ADMIN_USER:-root}
[ -n "$HOST" ] || die 'MYSQL_ADMIN_HOST (or DB_HOST) is required'
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD is required}"
identifier "$FROM_DB" FROM_DB 64; identifier "$TO_DB" TO_DB 64
runtime_database "$FROM_DB" && runtime_database "$TO_DB" ||
  die 'FROM_DB and TO_DB must each be aida_pbx_db, aidacalls_db or a disposable aida_*_test schema'
identifier "$FROM_USER" FROM_USER 32; identifier "$TO_USER" TO_USER 32; identifier "$ADMIN" MYSQL_ADMIN_USER 32
port "$PORT"
for user in "$FROM_USER" "$TO_USER"; do
  [[ $user != "$ADMIN" ]] || die 'The runtime account cannot be the admin account'
  case "$user" in root|mysql.*) die 'System accounts cannot be application accounts';; esac
done
[[ $FROM_DB != "$TO_DB" || $FROM_USER != "$TO_USER" ]] || die 'Nothing to rename: FROM and TO are the same'

sql() { # Statements on stdin; tab-separated rows on stdout.
  MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP --host="$HOST" --port="$PORT" --user="$ADMIN" \
    --connect-timeout=10 --default-character-set=utf8mb4 --binary-mode --batch --skip-column-names
}
# Names are validated plain identifiers, so they are safe inside quotes.
count() { sql <<<"$1" | tr -d '[:space:]'; }
schema_exists() { [ "$(count "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='$1'")" = 1 ]; }
table_count() { count "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$1'"; }
user_exists() { [ "$(count "SELECT COUNT(*) FROM mysql.user WHERE User='$1' AND Host='%'")" = 1 ]; }

count 'SELECT 1' >/dev/null || die "Cannot connect to MySQL at $HOST:$PORT as $ADMIN"

# ── Preflight: refuse anything this script would not leave consistent ────────
if [[ $FROM_DB != "$TO_DB" ]] && schema_exists "$FROM_DB"; then
  others=$(count "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$FROM_DB' AND TABLE_TYPE<>'BASE TABLE')
    + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$FROM_DB')
    + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='$FROM_DB')
    + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA='$FROM_DB')")
  [ "$others" = 0 ] || die "$FROM_DB has views, triggers, routines or events, which RENAME TABLE cannot move: move them by hand"
  if schema_exists "$TO_DB" && [ "$(table_count "$TO_DB")" != 0 ] && [ "$(table_count "$FROM_DB")" != 0 ]; then
    die "Both $FROM_DB and $TO_DB hold tables: decide which is current, and empty or drop the other"
  fi
fi
busy=$(count "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (USER IN ('$FROM_USER','$TO_USER') OR DB IN ('$FROM_DB','$TO_DB'))")
[ "$busy" = 0 ] || die "$busy connection(s) still use $FROM_DB or $FROM_USER: stop the AidaPbx service first"

# ── The database ─────────────────────────────────────────────────────────────
if [[ $FROM_DB == "$TO_DB" ]]; then :
elif schema_exists "$FROM_DB"; then
  tables=$(sql <<<"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$FROM_DB' ORDER BY TABLE_NAME")
  renames=""
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    identifier "$table" "table name" 64
    renames+="${renames:+, }\`$FROM_DB\`.\`$table\` TO \`$TO_DB\`.\`$table\`"
  done <<<"$tables"
  {
    echo "CREATE DATABASE IF NOT EXISTS \`$TO_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
    # One statement: every table moves, or none does.
    [ -z "$renames" ] || echo "RENAME TABLE $renames;"
  } | sql >/dev/null
  [ "$(table_count "$FROM_DB")" = 0 ] || die "$FROM_DB still holds tables after the move; nothing was dropped"
  sql <<<"DROP DATABASE \`$FROM_DB\`;" >/dev/null
  say "moved $(grep -c . <<<"$tables" || true) table(s) from $FROM_DB to $TO_DB and dropped the empty $FROM_DB"
elif schema_exists "$TO_DB"; then
  say "$TO_DB already exists and $FROM_DB does not: database already renamed"
else
  die "Neither $FROM_DB nor $TO_DB exists on $HOST"
fi

# ── The account ──────────────────────────────────────────────────────────────
if [[ $FROM_USER == "$TO_USER" ]]; then :
elif user_exists "$FROM_USER" && ! user_exists "$TO_USER"; then
  sql <<<"RENAME USER '$FROM_USER'@'%' TO '$TO_USER'@'%';" >/dev/null
  say "renamed account $FROM_USER to $TO_USER (password unchanged)"
elif user_exists "$TO_USER"; then
  if user_exists "$FROM_USER"; then
    say "$TO_USER already exists, so $FROM_USER was left alone: once nothing logs in as it, DROP USER '$FROM_USER'@'%';"
  else
    say "account $TO_USER already exists and $FROM_USER does not: account already renamed"
  fi
else
  die "Neither account $FROM_USER nor $TO_USER exists on $HOST"
fi

# Grants name the database, so they are rewritten for the new one; database-level
# GRANT treats _ and % as wildcards, hence the escaping (as in db-users.sh).
GRANT_DATABASE=${TO_DB//_/\\_}
sql >/dev/null <<SQL
REVOKE ALL PRIVILEGES, GRANT OPTION FROM '$TO_USER'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER ON \`$GRANT_DATABASE\`.* TO '$TO_USER'@'%';
SQL
say "$TO_USER: runtime DML and migrations on $TO_DB"
say "next: set aida-pbx/DB_NAME=$TO_DB and aida-pbx/DB_USER=$TO_USER, then start AidaPbx"
