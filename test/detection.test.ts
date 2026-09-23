import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageLimitDetector } from '../src/providers/detect.ts';

const NOW = 1_700_000_000_000;

test('detects Codex usage limit with friendly message and parses reset time', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'You have hit your ChatGPT usage limit. Try again in ~42 min.',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 1000);
  assert.ok(hit);
  assert.equal(hit.provider, 'codex');
  assert.ok(hit.resetAt);
  const expected = NOW + 1000 + 42 * 60 * 1000;
  assert.equal(hit.resetAt, expected);
});

test('detects Anthropic usage limit with unified-reset header', () => {
  const d = createUsageLimitDetector();
  const resetDate = new Date(NOW + 3600_000).toISOString();
  d.onProviderResponse('anthropic', 429, { 'anthropic-ratelimit-unified-reset': resetDate }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
  assert.ok(hit.resetAt);
  assert.ok(Math.abs(hit.resetAt - (NOW + 3600_000)) < 1000);
});

test('detects Anthropic usage limit with retry-after header', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, { 'retry-after': '300' }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
  assert.ok(hit.resetAt);
  assert.equal(hit.resetAt, NOW + 300 * 1000);
});

test('Error followed by NonError clears stale evidence and run error', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_limit_reached',
    resetsAt: undefined,
  });
  d.onRunEnd({ _tag: 'NonError' });
  assert.equal(d.classify(NOW), undefined);
});

test('attempt start isolates rate-limit evidence from the next retry', () => {
  const d = createUsageLimitDetector();
  d.onRunStart();
  d.onProviderResponse('anthropic', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate_limit_error',
    resetsAt: undefined,
  });

  d.onRunStart();
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'internal server error',
    resetsAt: undefined,
  });

  assert.equal(d.classify(NOW + 500), undefined);
});

test('final exhausted attempt still classifies its own limit evidence', () => {
  const d = createUsageLimitDetector();
  d.onRunStart();
  d.onProviderResponse('anthropic', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'internal server error',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
});

test('newest Error observation wins', () => {
  const d = createUsageLimitDetector();
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_limit_reached',
    resetsAt: undefined,
  });
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: NOW + 60_000,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
  assert.equal(hit.resetAt, NOW + 60_000);
});

test('cross-family 429 evidence is rejected', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, { 'retry-after': '300' }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_limit_reached',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'codex');
  assert.equal(hit.resetAt, undefined);
});

test('429 evidence exactly 600 seconds old is stale', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, { 'retry-after': '300' }, NOW - 600_000);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.resetAt, undefined);
});

test('mixed-case rate-limit headers are normalized', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, { 'Retry-After': '300' }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: undefined,
  });
  assert.equal(d.classify(NOW + 1)?.resetAt, NOW + 300_000);
});

test('ordinary openai provider is ignored', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai', 429, { 'retry-after': '300' }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai',
    errorMessage: 'usage limit exceeded',
    resetsAt: undefined,
  });
  assert.equal(d.classify(NOW), undefined);
});

test('returns undefined when no run error', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  const hit = d.classify(NOW + 500);
  assert.equal(hit, undefined);
});

test('returns undefined for billing/quota errors', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'Your billing quota has been exhausted.',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.equal(hit, undefined);
});

test('returns undefined for usage_not_included', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_not_included: Your plan does not include this feature.',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.equal(hit, undefined);
});

test('ignores stale 429 evidence but still classifies from error message', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW - 700_000);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_limit_reached',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.provider, 'codex');
});

test('classify consumes evidence', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'usage_limit_reached',
    resetsAt: undefined,
  });
  const first = d.classify(NOW + 500);
  assert.ok(first);
  const second = d.classify(NOW + 1000);
  assert.equal(second, undefined);
});

test('detects limit from error message alone without 429 evidence', () => {
  const d = createUsageLimitDetector();
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'You have hit your ChatGPT usage limit. Try again in ~15 min.',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.provider, 'codex');
  assert.equal(hit.resetAt, NOW + 15 * 60 * 1000);
});

test('detects 429 even with unrecognized error message', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'internal server error',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
  assert.equal(hit.resetAt, undefined);
});

test('returns undefined for unrecognized error without 429', () => {
  const d = createUsageLimitDetector();
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'internal server error',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.equal(hit, undefined);
});

test('detects real Codex error "The usage limit has been reached"', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('openai-codex', 429, {}, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'Codex error: The usage limit has been reached',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'codex');
  assert.equal(hit.resetAt, undefined);
});

test('prefers structured resetsAt over error message parsing', () => {
  const d = createUsageLimitDetector();
  const structuredReset = NOW + 7200_000;
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'Codex error: The usage limit has been reached',
    resetsAt: structuredReset,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.resetAt, structuredReset);
});

test('structured resetsAt passes through as-is (caller normalizes to ms)', () => {
  const d = createUsageLimitDetector();
  const resetMs = NOW + 3600_000;
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'Codex error: The usage limit has been reached',
    resetsAt: resetMs,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.resetAt, resetMs);
});

test('falls back to error message parsing when resetsAt is undefined', () => {
  const d = createUsageLimitDetector();
  d.onRunEnd({
    _tag: 'Error',
    provider: 'openai-codex',
    errorMessage: 'You have hit your ChatGPT usage limit. Try again in ~10 min.',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW);
  assert.ok(hit);
  assert.equal(hit.resetAt, NOW + 10 * 60 * 1000);
});

test('uses provider from ctx.model, not hardcoded unknown', () => {
  const d = createUsageLimitDetector();
  d.onProviderResponse('anthropic', 429, { 'retry-after': '120' }, NOW);
  d.onRunEnd({
    _tag: 'Error',
    provider: 'anthropic',
    errorMessage: 'rate limit exceeded',
    resetsAt: undefined,
  });
  const hit = d.classify(NOW + 500);
  assert.ok(hit);
  assert.equal(hit.provider, 'anthropic');
  assert.equal(hit.resetAt, NOW + 120 * 1000);
});
