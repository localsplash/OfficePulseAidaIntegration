-- `aida_officepulse`: the runtime database OfficePulseAidaIntegration owns
-- and is the sole writer of (issue #9). AidaAdmin may READ it through a
-- read-only account; commands remain HTTP actions, never table writes.
--
-- Deliberately absent: any transcript table. Live transcripts travel over
-- LiveKit Data and are not persisted in the POC.

CREATE DATABASE IF NOT EXISTS aida_officepulse
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE aida_officepulse;

-- One row per inbound call. `config_*` columns PIN the AidaAdmin ids and
-- revisions this call actually used, so behaviour stays explainable after
-- an administrator edits the configuration mid-call.
CREATE TABLE IF NOT EXISTS call_session (
  id                       CHAR(36)     NOT NULL,
  asterisk_linked_id       VARCHAR(80)  NOT NULL,
  officepulse_instance_id  VARCHAR(80)  NOT NULL,
  tenant_id                VARCHAR(60)  NOT NULL,
  did_e164                 VARCHAR(20)  NOT NULL,
  caller_number            VARCHAR(32)  NULL,
  config_did_route_id      VARCHAR(60)  NULL,
  config_did_route_rev     INT          NULL,
  config_profile_id        VARCHAR(60)  NULL,
  config_profile_rev       INT          NULL,
  config_tenant_rev        INT          NULL,
  room_name                VARCHAR(120) NULL,
  agent_participant_sid    VARCHAR(80)  NULL,
  destination_type         VARCHAR(20)  NULL,
  destination_id           VARCHAR(60)  NULL,
  disposition              VARCHAR(20)  NOT NULL,
  state                    VARCHAR(30)  NOT NULL,
  version                  INT          NOT NULL DEFAULT 1,
  created_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at                 TIMESTAMP    NULL,
  PRIMARY KEY (id),
  -- Idempotency for FastAGI retries: one call session per Asterisk call.
  UNIQUE KEY uq_call_session_linkedid (asterisk_linked_id),
  UNIQUE KEY uq_call_session_room (room_name),
  KEY idx_call_session_tenant (tenant_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Durable, ordered call lifecycle events (ringing, answered, bridged,
-- drained, hangup, agent acknowledgements).
CREATE TABLE IF NOT EXISTS call_event (
  id               CHAR(36)     NOT NULL,
  call_session_id  CHAR(36)     NOT NULL,
  sequence_number  INT          NOT NULL,
  event_type       VARCHAR(60)  NOT NULL,
  payload          JSON         NULL,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_call_event_sequence (call_session_id, sequence_number),
  KEY idx_call_event_session (call_session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Allowlisted call-control commands. The unique idempotency key makes a
-- duplicate submission a replay rather than a second takeover.
CREATE TABLE IF NOT EXISTS control_command (
  id               CHAR(36)     NOT NULL,
  call_session_id  CHAR(36)     NOT NULL,
  idempotency_key  VARCHAR(120) NOT NULL,
  command_type     VARCHAR(40)  NOT NULL,
  payload          JSON         NULL,
  status           VARCHAR(20)  NOT NULL,
  result           JSON         NULL,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at     TIMESTAMP(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_control_command_idem (call_session_id, idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Current LiveKit participants per call (agent + SIP legs).
CREATE TABLE IF NOT EXISTS livekit_participant (
  call_session_id  CHAR(36)     NOT NULL,
  participant_sid  VARCHAR(80)  NOT NULL,
  identity         VARCHAR(120) NULL,
  kind             VARCHAR(20)  NOT NULL,
  joined_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  left_at          TIMESTAMP(3) NULL,
  PRIMARY KEY (call_session_id, participant_sid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Verified LiveKit webhook deliveries; the unique id suppresses replays.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  delivery_id      VARCHAR(120) NOT NULL,
  source           VARCHAR(30)  NOT NULL,
  event_type       VARCHAR(60)  NOT NULL,
  call_session_id  CHAR(36)     NULL,
  received_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (source, delivery_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Provisioning idempotency + outcome, replacing the bookkeeping table that
-- previously lived beside the Asterisk Realtime tables. Never stores a
-- secret: a replay returns "already applied", never the existing secret.
CREATE TABLE IF NOT EXISTS provisioning_operation (
  request_id   VARCHAR(120) NOT NULL,
  kind         VARCHAR(20)  NOT NULL,
  external_id  VARCHAR(60)  NOT NULL,
  action       VARCHAR(30)  NOT NULL,
  status       VARCHAR(20)  NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Latest known state of every dependency, reported independently.
CREATE TABLE IF NOT EXISTS dependency_status (
  name        VARCHAR(40) NOT NULL,
  ready       TINYINT(1)  NOT NULL,
  detail      VARCHAR(255) NULL,
  changed_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- DID -> destination projection written at provisioning time. This is the
-- local fail-safe: when NocoDB or LiveKit is unavailable the caller is
-- still routed to THIS DID's own destination. tenant_id is stored so a
-- fallback can never cross tenants.
CREATE TABLE IF NOT EXISTS did_fallback (
  did_route_id      VARCHAR(60) NOT NULL,
  tenant_id         VARCHAR(60) NOT NULL,
  did_e164          VARCHAR(20) NOT NULL,
  destination_type  VARCHAR(20) NOT NULL,
  destination_id    VARCHAR(60) NOT NULL,
  enabled           TINYINT(1)  NOT NULL DEFAULT 1,
  updated_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (did_route_id),
  UNIQUE KEY uq_did_fallback_did (did_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
