import assert from 'node:assert/strict';
import test from 'node:test';

import {
  codexAccountId,
  codexResetFromBody,
  fetchCodexReset,
  isCodexUsageLimit,
  parseCodexErrorBody,
  parseCodexHeaders,
} from '../src/providers/codex.ts';
import type { FetchLike } from '../src/providers/client.ts';

const NOW = 1_700_000_000_000;

test('isCodexUsageLimit matches friendly message', () => {
  assert.ok(isCodexUsageLimit('You have hit your ChatGPT usage limit', undefined));
});

test('isCodexUsageLimit matches usage_limit_reached code', () => {
  assert.ok(isCodexUsageLimit('usage_limit_reached', undefined));
});

test('isCodexUsageLimit matches 429 status', () => {
  assert.ok(isCodexUsageLimit('some error', 429));
});

test('isCodexUsageLimit rejects unrelated error', () => {
  assert.ok(!isCodexUsageLimit('internal server error', undefined));
});

test('parseCodexHeaders reads x-ratelimit-reset', () => {
  const resetEpoch = NOW + 3600_000;
  const result = parseCodexHeaders({ 'x-ratelimit-reset': String(resetEpoch) }, NOW);
  assert.equal(result, resetEpoch);
});

test('parseCodexHeaders reads retry-after', () => {
  const result = parseCodexHeaders({ 'retry-after': '300' }, NOW);
  assert.equal(result, NOW + 300_000);
});

test('parseCodexHeaders rejects non-finite and non-positive epochs', () => {
  assert.equal(parseCodexHeaders({ 'x-ratelimit-reset': 'Infinity' }, NOW), undefined);
  assert.equal(parseCodexHeaders({ 'x-ratelimit-reset': '0' }, NOW), undefined);
  assert.equal(parseCodexHeaders({ 'retry-after': 'Infinity' }, NOW), undefined);
});

test('parseCodexErrorBody parses ~N min', () => {
  const result = parseCodexErrorBody('Try again in ~42 min.', NOW);
  assert.equal(result, NOW + 42 * 60_000);
});

test('parseCodexErrorBody parses resets_at epoch', () => {
  const epoch = Math.floor(NOW / 1000) + 3600;
  const result = parseCodexErrorBody(`resets_at: ${epoch}`, NOW);
  assert.equal(result, epoch * 1000);
});

test('codexAccountId extracts from nested claim', () => {
  const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'abc-123' } };
  const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
  assert.equal(codexAccountId(token), 'abc-123');
});

test('codexAccountId returns undefined for invalid token', () => {
  assert.equal(codexAccountId('not-a-jwt'), undefined);
});

test('codexResetFromBody reads reset_at', () => {
  const body = { rate_limit: { primary_window: { reset_at: 1700003600 } } };
  const result = codexResetFromBody(body, NOW);
  assert.ok(result);
  assert.equal(result.at, 1700003600 * 1000);
  assert.equal(result.source, 'usage-api');
});

test('codexResetFromBody reads reset_after_seconds', () => {
  const body = { rate_limit: { primary_window: { reset_after_seconds: 600 } } };
  const result = codexResetFromBody(body, NOW);
  assert.ok(result);
  assert.equal(result.at, NOW + 600_000);
});

test('codexResetFromBody returns null for empty body', () => {
  assert.equal(codexResetFromBody({}, NOW), null);
});

test('fetchCodexReset returns reset from usage API', async () => {
  const resetEpoch = Math.floor(NOW / 1000) + 3600;
  const fakeFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rate_limit: { primary_window: { reset_at: resetEpoch } } }),
  });
  const result = await fetchCodexReset({ token: 'test-token', fetchImpl: fakeFetch, now: NOW });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.reset.at, resetEpoch * 1000);
    assert.equal(result.reset.source, 'usage-api');
  }
});

test('fetchCodexReset handles 401', async () => {
  const fakeFetch: FetchLike = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const result = await fetchCodexReset({ token: 'bad', fetchImpl: fakeFetch, now: NOW });
  assert.ok(!result.ok);
});

test('fetchCodexReset handles network error', async () => {
  const fakeFetch: FetchLike = async () => {
    throw new Error('network down');
  };
  const result = await fetchCodexReset({ token: 'test', fetchImpl: fakeFetch, now: NOW });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.error.includes('network down'));
  }
});
