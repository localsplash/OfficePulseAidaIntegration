-- Operator-run migration for the verified officepulse-dev Asterisk Realtime
-- schema. Run before creating the PBX inventory/provisioning accounts.
--
-- The application never executes this DDL. Take a schema backup, confirm that
-- both preflight rows describe varchar(40), and schedule the ALTER statements
-- under the site's normal database change procedure. Widening preserves all
-- existing values and unique keys. Re-running produces the same schema.

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'asterisk'
  AND ((TABLE_NAME = 'extensions' AND COLUMN_NAME = 'exten')
    OR (TABLE_NAME = 'ps_endpoints' AND COLUMN_NAME = 'callerid'))
ORDER BY TABLE_NAME, COLUMN_NAME;

ALTER TABLE asterisk.extensions
  MODIFY COLUMN exten VARCHAR(80)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;

ALTER TABLE asterisk.ps_endpoints
  MODIFY COLUMN callerid VARCHAR(80)
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL;

-- Both rows must report varchar(80). The extensions context unique key and
-- endpoint id unique key must remain present after the change.
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'asterisk'
  AND ((TABLE_NAME = 'extensions' AND COLUMN_NAME = 'exten')
    OR (TABLE_NAME = 'ps_endpoints' AND COLUMN_NAME = 'callerid'))
ORDER BY TABLE_NAME, COLUMN_NAME;

SHOW INDEX FROM asterisk.extensions;
SHOW INDEX FROM asterisk.ps_endpoints;
