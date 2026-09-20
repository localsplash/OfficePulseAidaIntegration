-- Device capabilities belong to the integration, never the vendor database.
CREATE TABLE IF NOT EXISTS handset_device (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  pbx_instance_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  pbx_context VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  endpoint_id VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  iTenantId BIGINT NULL,
  extension VARCHAR(40) NULL,
  label VARCHAR(255) NULL,
  mac CHAR(12) NULL,
  public_ip VARCHAR(45) NOT NULL,
  local_ip VARCHAR(45) NOT NULL,
  device_model VARCHAR(120) NOT NULL,
  app_version VARCHAR(80) NOT NULL,
  attached_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  INDEX handset_scope (pbx_instance_id, pbx_context, endpoint_id),
  INDEX handset_install (pbx_instance_id, app_instance_id)
) ENGINE=InnoDB;
DROP TABLE IF EXISTS aida_tbl_DeviceEnrollment;
DROP TABLE IF EXISTS aida_tbl_DeviceSession;
