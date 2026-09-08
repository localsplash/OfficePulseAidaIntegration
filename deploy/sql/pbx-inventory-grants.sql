-- Apply manually only after verifying the installed Asterisk realtime schema.
-- Replace placeholders. This account is independent of the legacy writer.
CREATE USER IF NOT EXISTS 'aida_pbx_inventory_ro'@'__OFFICEPULSE_API_IP__'
  IDENTIFIED BY '__STRONG_PASSWORD__';
GRANT SELECT ON asterisk.ps_endpoints TO 'aida_pbx_inventory_ro'@'__OFFICEPULSE_API_IP__';
GRANT SELECT ON asterisk.queues TO 'aida_pbx_inventory_ro'@'__OFFICEPULSE_API_IP__';
GRANT SELECT ON asterisk.queue_members TO 'aida_pbx_inventory_ro'@'__OFFICEPULSE_API_IP__';
-- Do not grant ps_auths, DDL, writes, or direct AidaAdmin access to this account.
