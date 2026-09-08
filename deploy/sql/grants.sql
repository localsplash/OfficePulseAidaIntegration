-- Canonical integration runtime: apply with actual local development host/account values.
-- No PBX vendor writer grants are issued by this project.
CREATE USER IF NOT EXISTS 'aida_integration'@'__INTEGRATION_IP__' IDENTIFIED BY '__STRONG_PASSWORD__';
-- Startup initializes the runtime schema and drops explicitly retired Dev bookkeeping.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP ON aidacalls_db.* TO 'aida_integration'@'__INTEGRATION_IP__';
CREATE USER IF NOT EXISTS 'aidaadmin_ro'@'__AIDAADMIN_IP__' IDENTIFIED BY '__STRONG_PASSWORD__';
GRANT SELECT ON aidacalls_db.* TO 'aidaadmin_ro'@'__AIDAADMIN_IP__';
