-- Immutable, call-scoped bootstrap authorization. Hashes only; never transcript content.
CREATE TABLE IF NOT EXISTS agent_admission (
  call_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  data JSON NOT NULL,
  dispatch_id VARCHAR(120) NULL,
  sip_identity VARCHAR(120) NULL,
  sip_sid VARCHAR(80) NULL,
  agent_identity VARCHAR(120) NULL,
  agent_sid VARCHAR(80) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
