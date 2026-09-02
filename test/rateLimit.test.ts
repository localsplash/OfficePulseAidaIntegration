import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/http/rateLimit.js';

test('rate limiter enforces per-minute budget and refills over time', () => {
  let now = 0;
  const limiter = new RateLimiter(60, () => now);
  for (let i = 0; i < 60; i++) assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  // Another client has its own bucket.
  assert.equal(limiter.allow('b'), true);
  // After one second, one token has refilled.
  now = 1000;
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
});

test('sweep drops idle buckets', () => {
  let now = 0;
  const limiter = new RateLimiter(10, () => now);
  limiter.allow('a');
  now = 11 * 60_000;
  limiter.sweep();
  // Bucket recreated fresh with a full budget.
  for (let i = 0; i < 10; i++) assert.equal(limiter.allow('a'), true);
});
