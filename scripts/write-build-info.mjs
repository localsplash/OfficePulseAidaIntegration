import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let revision, epoch, dirty;
if (process.env.BUILD_REVISION || process.env.SOURCE_DATE_EPOCH) {
  // Source archives/containers have no Git metadata. Require a complete identity.
  revision = process.env.BUILD_REVISION;
  epoch = process.env.SOURCE_DATE_EPOCH;
  if (!['true', 'false'].includes(process.env.BUILD_DIRTY)) {
    throw new Error('Explicit metadata requires BUILD_DIRTY=true or false');
  }
  dirty = process.env.BUILD_DIRTY === 'true';
} else {
  revision = git('rev-parse', 'HEAD');
  epoch = git('show', '-s', '--format=%ct', 'HEAD');
  dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
}
if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(revision ?? '') || !/^\d+$/.test(epoch ?? '')) {
  throw new Error('Build requires a full BUILD_REVISION and integer SOURCE_DATE_EPOCH, or a Git checkout');
}
const date = new Date(Number(epoch) * 1000);
if (!Number.isSafeInteger(Number(epoch)) || !Number.isFinite(date.getTime())) {
  throw new Error('Invalid SOURCE_DATE_EPOCH');
}
const version = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()].join('.');
const buildInfo = { version: version + (dirty ? '-dirty' : ''), revision, sourceUpdatedAt: date.toISOString(), dirty };
mkdirSync('dist', { recursive: true });
// Replace the compiled development placeholder. Runtime needs neither Git nor env overrides.
writeFileSync('dist/buildInfo.js', `export const buildInfo = Object.freeze(${JSON.stringify(buildInfo)});\n`);
console.log(JSON.stringify(buildInfo));
