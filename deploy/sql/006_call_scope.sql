-- Routing scope of a call is {officepulse_instance_id, pbx_context} (#22): the extension context owning the
-- routed queue. ingress_context is the carrier context the DID arrived in, pinned so ownership can be
-- re-derived from the DID's own Realtime rows. Additive only; historical rows stay NULL. tenant_id remains
-- customer identity for authorization and observation, never a routing key.
ALTER TABLE call_session ADD COLUMN pbx_context VARCHAR(40) NULL, ADD COLUMN ingress_context VARCHAR(40) NULL;
