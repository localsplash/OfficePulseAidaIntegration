import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseManifest, validatePrompts, type PromptManifest } from '../src/prompts/manifest.js';

function manifestFor(sha256: string | null): PromptManifest {
  return {
    prompts: [
      {
        name: 'aida-recording-disclosure',
        version: 1,
        format: 'ulaw',
        sampleRateHz: 8000,
        sha256,
        sourceText: 'This call may be recorded.',
      },
    ],
  };
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompts-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('valid audio matching the pinned checksum passes', async () => {
  await withDir(async (dir) => {
    const audio = Buffer.from('fake-ulaw-bytes');
    const digest = createHash('sha256').update(audio).digest('hex');
    await writeFile(path.join(dir, 'aida-recording-disclosure.ulaw'), audio);
    const result = await validatePrompts(manifestFor(digest), dir);
    assert.deepEqual(result, { ok: true, problems: [] });
  });
});

test('missing file fails validation', async () => {
  await withDir(async (dir) => {
    const result = await validatePrompts(manifestFor('0'.repeat(64)), dir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('missing')));
  });
});

test('corrupt file (checksum mismatch) fails validation', async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, 'aida-recording-disclosure.ulaw'), Buffer.from('tampered'));
    const result = await validatePrompts(manifestFor('0'.repeat(64)), dir);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('checksum mismatch')));
  });
});

test('unpinned checksum, bad sample rate, and bad format are rejected', async () => {
  await withDir(async (dir) => {
    const unpinned = await validatePrompts(manifestFor(null), dir);
    assert.ok(unpinned.problems.some((p) => p.includes('no pinned sha256')));

    const manifest = manifestFor('0'.repeat(64));
    const prompt = manifest.prompts[0];
    assert.ok(prompt);
    prompt.sampleRateHz = 44100;
    prompt.format = 'mp3';
    const result = await validatePrompts(manifest, dir);
    assert.ok(result.problems.some((p) => p.includes('8000 Hz')));
    assert.ok(result.problems.some((p) => p.includes('unsupported format')));
  });
});

test('the committed manifest parses and lists the three POC prompts', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = parseManifest(await readFile(new URL('../prompts/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    manifest.prompts.map((p) => p.name),
    ['aida-recording-disclosure', 'aida-circuits-busy', 'aida-agent-incident'],
  );
});
