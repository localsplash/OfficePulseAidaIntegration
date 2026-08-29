#!/usr/bin/env bash
# Generate prompt audio from manifest sourceText and pin checksums.
#
# Uses espeak-ng (or a directory of pre-recorded WAV sources passed as
# $1) plus ffmpeg/sox to produce 8 kHz mono ulaw files Asterisk can play
# natively, then rewrites manifest.json with each file's sha256.
#
# Usage:
#   scripts/generate-prompts.sh                 # synthesize with espeak-ng
#   scripts/generate-prompts.sh /path/to/wavs   # convert recorded WAVs named <prompt>.wav
set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST=prompts/manifest.json
OUT=prompts/audio
SRC_DIR="${1:-}"
mkdir -p "$OUT"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
if [ -z "$SRC_DIR" ]; then
  command -v espeak-ng >/dev/null || { echo "espeak-ng is required for synthesis (or pass a WAV source dir)" >&2; exit 1; }
fi

names=$(node -e "const m=require('./$MANIFEST'); for (const p of m.prompts) console.log(p.name)")
for name in $names; do
  text=$(node -e "const m=require('./$MANIFEST'); console.log(m.prompts.find(p=>p.name==='$name').sourceText)")
  tmp=$(mktemp --suffix=.wav)
  if [ -n "$SRC_DIR" ]; then
    cp "$SRC_DIR/$name.wav" "$tmp"
  else
    espeak-ng -w "$tmp" "$text"
  fi
  # 8 kHz mono mu-law raw — Asterisk .ulaw format.
  ffmpeg -loglevel error -y -i "$tmp" -ar 8000 -ac 1 -f mulaw "$OUT/$name.ulaw"
  rm -f "$tmp"
  echo "generated $OUT/$name.ulaw"
done

# Pin checksums into the manifest.
node -e "
const fs = require('fs');
const crypto = require('crypto');
const m = JSON.parse(fs.readFileSync('$MANIFEST', 'utf8'));
for (const p of m.prompts) {
  const file = '$OUT/' + p.name + '.' + p.format;
  p.sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
fs.writeFileSync('$MANIFEST', JSON.stringify(m, null, 2) + '\n');
console.log('manifest checksums pinned');
"

npm run --silent validate:prompts
