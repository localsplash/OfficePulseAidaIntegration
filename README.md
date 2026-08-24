# OfficePulseAidaIntegration

Layer Aida onto OfficePulse without forking or modifying Asterisk source.

## Responsibilities

- Own ARI/Stasis connectivity and reconciliation
- Install a versioned Aida dialplan include and ARI configuration template
- Pass signed X-Aida-* headers through the existing LiveKit SIP trunk
- Originate one enrolled PJSIP endpoint and perform safe takeover bridging
- Deploy disclosure, failure, and customizable hold audio with rollback scripts

## Stack

TypeScript, Node.js, Asterisk ARI/Stasis, Docker or system service, GitHub Actions

## System specification

[Canonical Aida Voice Platform specification](https://github.com/localsplash/AidaInfrastructureSetupInstructions/blob/main/docs/AIDA_VOICE_PLATFORM_TECHNICAL_SPECIFICATION.md)

## Project invariant

No Aida failure or cleanup operation may tear down an established caller-human bridge.
