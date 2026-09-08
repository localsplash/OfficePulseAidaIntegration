-- Apply to the integration-owned runtime DB (configured aidacalls_db), never the PBX DB.
CREATE TABLE IF NOT EXISTS aida_tbl_DeviceEnrollment (
  tokenHash CHAR(64) PRIMARY KEY,
  iTenantId BIGINT NOT NULL,
  uidExtension VARCHAR(60) NOT NULL,
  dtCreated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dtExpires DATETIME(3) NOT NULL,
  dtConsumed DATETIME(3) NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS aida_tbl_DeviceSession (
  uidDevice CHAR(36) PRIMARY KEY,
  iTenantId BIGINT NOT NULL,
  uidExtension VARCHAR(60) NOT NULL,
  hardwareId VARCHAR(120) NOT NULL,
  tokenHash CHAR(64) NOT NULL UNIQUE,
  dtCreated DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  dtRevoked DATETIME(3) NULL,
  INDEX idx_device_extension (iTenantId,uidExtension,hardwareId)
) ENGINE=InnoDB;
