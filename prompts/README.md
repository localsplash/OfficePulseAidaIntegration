# Aida prompt assets

`manifest.json` is the source of truth for the deployable prompts: name,
version, audio format, sample rate, pinned sha256, and the voiceover
source text. The POC ships **English only** — no Spanish assets and no
language menu.

| Prompt | Played to | When |
|---|---|---|
| `aida-recording-disclosure` | caller | always, before FastAGI/LiveKit — first thing on every DID |
| `aida-circuits-busy` | caller | Aida/LiveKit/AidaControl unavailable, before direct fallback dial |
| `aida-agent-incident` | answering extension | after answer on the fallback path, before bridging |

## Workflow

1. Record or synthesize source audio for each `sourceText`.
2. `scripts/generate-prompts.sh` converts to 8 kHz mono ulaw into
   `prompts/audio/` and pins each file's sha256 into `manifest.json`.
3. `npm run validate:prompts` verifies presence + checksum + format.
4. `scripts/deploy-prompts.sh` validates first and only then installs to
   the Asterisk sounds directory (`.../sounds/aida/`) with correct
   ownership, keeping the previous version for rollback.

A missing or corrupt file fails validation, and deployment aborts
**before** any Asterisk reload.

Generated audio is not committed (see `.gitignore`); the manifest with
pinned checksums is.
