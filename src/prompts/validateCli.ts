import { readFile } from 'node:fs/promises';
import { parseManifest, validatePrompts } from './manifest.js';

/**
 * CLI: validate the prompt manifest against generated audio files.
 * Usage: tsx src/prompts/validateCli.ts <manifest.json> <audioDir>
 * Exits non-zero on any problem so deployment scripts can gate on it.
 */
async function main(): Promise<void> {
  const [manifestPath, audioDir] = process.argv.slice(2);
  if (!manifestPath || !audioDir) {
    console.error('usage: validateCli <manifest.json> <audioDir>');
    process.exit(2);
  }
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const result = await validatePrompts(manifest, audioDir);
  if (result.ok) {
    console.log(`prompt manifest OK (${manifest.prompts.length} prompts)`);
    return;
  }
  for (const problem of result.problems) console.error(`PROMPT VALIDATION: ${problem}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
