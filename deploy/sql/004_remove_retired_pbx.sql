-- Retire only OfficePulse-owned PBX projection/sync bookkeeping.
-- No vendor asterisk objects, device state, or observed call history are touched.
DROP TABLE IF EXISTS provisioning_operation;
DROP TABLE IF EXISTS did_fallback;
DELETE FROM dependency_status WHERE name IN ('asterisk-mysql', 'provisioning-adapter');
