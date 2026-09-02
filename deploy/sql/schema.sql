-- Bookkeeping tables owned by OfficePulseAidaIntegration, created in the
-- OfficePulse Asterisk Realtime MySQL database alongside the installed
-- Asterisk 22.10.1 schemas (ps_endpoints, ps_auths, ps_aors, extensions,
-- cdr, cel — which this file deliberately does NOT create or alter).

CREATE TABLE IF NOT EXISTS aida_object (
  kind        ENUM('EXTENSION', 'RING_GROUP', 'DID') NOT NULL,
  external_id CHAR(36)     NOT NULL,
  tenant_id   CHAR(36)     NULL,
  context     VARCHAR(60)  NOT NULL,
  exten       VARCHAR(40)  NOT NULL,
  endpoint_id VARCHAR(80)  NULL,
  enabled     TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, external_id),
  KEY idx_aida_object_location (kind, context, exten)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS aida_device (
  device_id             CHAR(36)    NOT NULL,
  extension_external_id CHAR(36)    NOT NULL,
  provisioning_mac      CHAR(12)    NOT NULL,
  provisioning_profile  VARCHAR(60) NULL,
  updated_at            TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  UNIQUE KEY uq_aida_device_extension (extension_external_id),
  UNIQUE KEY uq_aida_device_mac (provisioning_mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Replay/idempotency storage for provisioning requests. NEVER stores
-- response payloads: replays of a create/rotation re-read the secret
-- from ps_auths, its only storage location.
CREATE TABLE IF NOT EXISTS aida_provisioning_request (
  request_id  VARCHAR(120) NOT NULL,
  kind        VARCHAR(20)  NOT NULL,
  external_id CHAR(36)     NOT NULL,
  action      VARCHAR(30)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
