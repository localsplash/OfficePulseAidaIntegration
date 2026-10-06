-- Operator-run only. Replace the source host and password, and adjust the
-- `asterisk` database identifier if required. Do not reuse migration/inventory
-- users. Existing users deliberately fail creation so grants are reviewed.
-- Realtime tables must already exist and use InnoDB. Require unique endpoint,
-- auth and AOR ids, queue names and (context, exten, priority) dialplan rows.
-- The application performs no DDL and needs neither UPDATE nor global grants.
CREATE USER 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__'
  IDENTIFIED BY '__STRONG_PASSWORD__';
GRANT SELECT (id), INSERT, DELETE ON asterisk.ps_aors TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
GRANT SELECT (id), INSERT, DELETE ON asterisk.ps_auths TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
GRANT SELECT, INSERT, DELETE ON asterisk.ps_endpoints TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
GRANT SELECT, INSERT, DELETE ON asterisk.extensions TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
GRANT SELECT, INSERT, DELETE ON asterisk.queues TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
GRANT SELECT, INSERT, DELETE ON asterisk.queue_members TO 'aida_pbx_provisioner'@'__OFFICEPULSE_API_IP__';
