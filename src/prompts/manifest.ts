import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Prompt manifest validation (POC issue 5). The manifest pins every
 * deployable prompt's name, version, audio format, and sha256. Deployment
 * scripts refuse to touch Asterisk until every prompt file exists and
 * hashes to the pinned value — a missing or corrupt prompt fails the
 * deployment before any reload.
 */

export interface PromptEntry {
  name: string;
  version: number;
  /** Asterisk-native format extension, e.g. ulaw, alaw, sln. */
  format: string;
  sampleRateHz: number;
  sha256: string | null;
  sourceText: string;
}

export interface PromptManifest {
  prompts: PromptEntry[];
}

export interface PromptValidationResult {
  ok: boolean;
  problems: string[];
}

const NAME_RE = /^[a-z0-9-]{1,60}$/;
const FORMATS = new Set(['ulaw', 'alaw', 'sln', 'wav', 'gsm']);

export function parseManifest(json: string): PromptManifest {
  const data = JSON.parse(json) as PromptManifest;
  if (!Array.isArray(data?.prompts)) throw new Error('manifest must contain a prompts array');
  return data;
}

export async function validatePrompts(manifest: PromptManifest, audioDir: string): Promise<PromptValidationResult> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const prompt of manifest.prompts) {
    if (!NAME_RE.test(prompt.name)) {
      problems.push(`prompt name '${prompt.name}' is invalid`);
      continue;
    }
    if (seen.has(prompt.name)) problems.push(`duplicate prompt '${prompt.name}'`);
    seen.add(prompt.name);
    if (!FORMATS.has(prompt.format)) problems.push(`prompt '${prompt.name}' has unsupported format '${prompt.format}'`);
    if (!Number.isInteger(prompt.version) || prompt.version < 1) problems.push(`prompt '${prompt.name}' has invalid version`);
    if (prompt.sampleRateHz !== 8000) problems.push(`prompt '${prompt.name}' must be 8000 Hz for the POC trunks`);
    if (typeof prompt.sourceText !== 'string' || prompt.sourceText.trim() === '') {
      problems.push(`prompt '${prompt.name}' is missing sourceText`);
    }

    const file = path.join(audioDir, `${prompt.name}.${prompt.format}`);
    if (prompt.sha256 === null) {
      problems.push(`prompt '${prompt.name}' has no pinned sha256 — generate audio first (scripts/generate-prompts.sh)`);
      continue;
    }
    try {
      const info = await stat(file);
      if (info.size === 0) {
        problems.push(`prompt file '${file}' is empty`);
        continue;
      }
      const content = await readFile(file);
      const digest = createHash('sha256').update(content).digest('hex');
      if (digest !== prompt.sha256) {
        problems.push(`prompt file '${file}' checksum mismatch (corrupt or stale)`);
      }
    } catch {
      problems.push(`prompt file '${file}' is missing`);
    }
  }
  if (manifest.prompts.length === 0) problems.push('manifest lists no prompts');
  return { ok: problems.length === 0, problems };
}
