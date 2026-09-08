-- Least-privilege MySQL account for the integration service's
-- provisioning writer (POC issues 2/7). Run as a MySQL administrator on
-- the OfficePulse database server; replace the password placeholder and
-- the LSAidaOffice01 private IPv4.
--
-- The account can only touch the six tables the service uses — no DDL,
-- no other tables, no grants, and connections only from LSAidaOffice01.

CREATE USER IF NOT EXISTS 'aida_integration'@'__LSAIDAOFFICE01_IP__'
  IDENTIFIED BY '__STRONG_PASSWORD__';

GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.ps_endpoints TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.ps_auths     TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.ps_aors      TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.extensions   TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.aida_object  TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.aida_device  TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';
GRANT SELECT, INSERT               ON asterisk.aida_provisioning_request TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';

-- Runtime database (`aidacalls_db`): this service is its sole WRITER.
-- Same account, separate schema — the split keeps Asterisk's operational
-- tables and this service's own call state independently grantable.
GRANT SELECT, INSERT, UPDATE, DELETE ON aidacalls_db.* TO 'aida_integration'@'__LSAIDAOFFICE01_IP__';

-- AidaAdmin READS runtime state (call sessions, events, dependency status)
-- through its own account. Read-only by grant, not by convention: commands
-- stay HTTP actions, so no write privilege is issued here at all.
CREATE USER IF NOT EXISTS 'aidaadmin_ro'@'__AIDAADMIN_IP__'
  IDENTIFIED BY '__STRONG_PASSWORD__';
GRANT SELECT ON aidacalls_db.* TO 'aidaadmin_ro'@'__AIDAADMIN_IP__';

FLUSH PRIVILEGES;
