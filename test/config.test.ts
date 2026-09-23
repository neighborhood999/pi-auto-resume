import assert from 'node:assert/strict';
import test from 'node:test';

import { parseConfig } from '../src/config.ts';
import { DEFAULT_CONFIG } from '../src/schedule.ts';

test('empty object returns defaults', () => {
  const result = parseConfig({});
  assert.ok(result.ok);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.enabled, DEFAULT_CONFIG.enabled);
  assert.equal(result.config.bufferMs, DEFAULT_CONFIG.bufferMs);
  assert.equal(result.config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
  assert.equal(result.config.maxAttempts, DEFAULT_CONFIG.maxAttempts);
  assert.equal(result.config.resumePrompt, undefined);
});

test('null input fails', () => {
  const result = parseConfig(null);
  assert.equal(result.ok, false);
});

test('partial config merges with defaults', () => {
  const result = parseConfig({ enabled: false, maxAttempts: 3 });
  assert.ok(result.ok);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.enabled, false);
  assert.equal(result.config.maxAttempts, 3);
  assert.equal(result.config.bufferMs, DEFAULT_CONFIG.bufferMs);
  assert.equal(result.config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
});

test('invalid numeric values fall back to defaults', () => {
  const result = parseConfig({
    bufferMs: -1,
    pollIntervalMs: 'nope',
    maxAttempts: 0,
  });
  assert.ok(result.ok);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.bufferMs, DEFAULT_CONFIG.bufferMs);
  assert.equal(result.config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
  assert.equal(result.config.maxAttempts, DEFAULT_CONFIG.maxAttempts);
});

test('non-finite durations and fractional attempts fall back to defaults', () => {
  const result = parseConfig({ bufferMs: Infinity, pollIntervalMs: NaN, maxAttempts: 2.5 });
  assert.ok(result.ok);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.bufferMs, DEFAULT_CONFIG.bufferMs);
  assert.equal(result.config.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs);
  assert.equal(result.config.maxAttempts, DEFAULT_CONFIG.maxAttempts);
});

test('resumePrompt is preserved', () => {
  const result = parseConfig({ resumePrompt: 'custom prompt' });
  assert.ok(result.ok);
  if (!result.ok) {
    return;
  }
  assert.equal(result.config.resumePrompt, 'custom prompt');
});
