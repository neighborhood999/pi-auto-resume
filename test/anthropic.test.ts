import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicResetFromBody,
  fetchAnthropicReset,
  isAnthropicUsageLimit,
  parseAnthropicHeaders,
} from '../src/providers/anthropic.ts';
import type { FetchLike } from '../src/providers/client.ts';

const NOW = 1_700_000_000_000;

test('isAnthropicUsageLimit matches rate_limit_error', () => {
  assert.ok(isAnthropicUsageLimit('rate_limit_error', undefined));
});

test('isAnthropicUsageLimit matches 429 status', () => {
  assert.ok(isAnthropicUsageLimit('some error', 429));
});

test('isAnthropicUsageLimit matches "usage limit"', () => {
  assert.ok(isAnthropicUsageLimit('You hit a usage limit', undefined));
});

test('isAnthropicUsageLimit rejects unrelated error', () => {
  assert.ok(!isAnthropicUsageLimit('internal server error', undefined));
});

test('parseAnthropicHeaders reads unified-5h-reset', () => {
  const resetDate = new Date(NOW + 3600_000).toISOString();
  const result = parseAnthropicHeaders({ 'anthropic-ratelimit-unified-5h-reset': resetDate }, NOW);
  assert.ok(result);
  assert.ok(Math.abs(result - (NOW + 3600_000)) < 1000);
});

test('parseAnthropicHeaders reads unified-reset', () => {
  const resetDate = new Date(NOW + 3600_000).toISOString();
  const result = parseAnthropicHeaders({ 'anthropic-ratelimit-unified-reset': resetDate }, NOW);
  assert.ok(result);
  assert.ok(Math.abs(result - (NOW + 3600_000)) < 1000);
});

test('parseAnthropicHeaders reads retry-after', () => {
  const result = parseAnthropicHeaders({ 'retry-after': '300' }, NOW);
  assert.equal(result, NOW + 300_000);
});

test('parseAnthropicHeaders returns undefined for empty headers', () => {
  assert.equal(parseAnthropicHeaders({}, NOW), undefined);
});

test('parseAnthropicHeaders rejects non-finite retry-after', () => {
  assert.equal(parseAnthropicHeaders({ 'retry-after': 'Infinity' }, NOW), undefined);
  assert.equal(parseAnthropicHeaders({ 'retry-after': '0' }, NOW), undefined);
});

const MODEL = 'claude-opus-4-1';

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

test('anthropicResetFromBody reads five_hour.resets_at', () => {
  const body = { five_hour: { resets_at: iso(7200_000) } };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 7200_000)) < 1000);
  assert.equal(result.source, 'usage-api');
  assert.equal(result.window, 'five_hour');
});

test('anthropicResetFromBody reads seven_day.resets_at when five_hour is absent', () => {
  const body = { seven_day: { resets_at: iso(86_400_000) } };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 86_400_000)) < 1000);
  assert.equal(result.window, 'weekly');
});

test('anthropicResetFromBody prefers five_hour when no utilization info', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000) },
    seven_day: { resets_at: iso(86_400_000) },
  };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 3600_000)) < 1000);
  assert.equal(result.window, 'five_hour');
});

test('anthropicResetFromBody waits for an exhausted seven_day over an open five_hour', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 40 },
    seven_day: { resets_at: iso(86_400_000), utilization: 100 },
  };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 86_400_000)) < 1000);
  assert.equal(result.window, 'weekly');
});

test('anthropicResetFromBody picks the latest reset when both windows are exhausted', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 100 },
    seven_day: { resets_at: iso(86_400_000), utilization: 100 },
  };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 86_400_000)) < 1000);
  assert.equal(result.window, 'weekly');
});

test('anthropicResetFromBody falls back to five_hour when no window exhausted', () => {
  const body = {
    five_hour: { resets_at: iso(86_400_000), utilization: 50 },
    seven_day: { resets_at: iso(3600_000), utilization: 30 },
  };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.equal(result.window, 'five_hour');
});

test('anthropicResetFromBody waits for an exhausted model bucket that meters the model', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 40 },
    seven_day: { resets_at: iso(86_400_000), utilization: 60 },
    seven_day_opus: { resets_at: iso(172_800_000), utilization: 100 },
  };
  const result = anthropicResetFromBody(body, 'claude-opus-4-1');
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 172_800_000)) < 1000);
  assert.equal(result.window, 'weekly');
});

test('anthropicResetFromBody ignores an exhausted model bucket for other models', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 100 },
    seven_day_opus: { resets_at: iso(172_800_000), utilization: 100 },
  };
  const result = anthropicResetFromBody(body, 'claude-sonnet-4-5');
  assert.ok(result);
  assert.ok(Math.abs(result.at - (NOW + 3600_000)) < 1000);
  assert.equal(result.window, 'five_hour');
});

test('anthropicResetFromBody refuses an earlier window when the exhausted one has no reset', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 40 },
    seven_day: { utilization: 100 },
  };
  assert.equal(anthropicResetFromBody(body, MODEL), null);
  assert.equal(
    anthropicResetFromBody(
      {
        five_hour: { resets_at: iso(3600_000), utilization: 40 },
        seven_day: { utilization: 100, resets_at: 'soon' },
      },
      MODEL,
    ),
    null,
  );
});

test('anthropicResetFromBody ignores a non-standard weekly key', () => {
  const body = {
    five_hour: { resets_at: iso(3600_000), utilization: 40 },
    weekly: { resets_at: iso(86_400_000), utilization: 100 },
  };
  const result = anthropicResetFromBody(body, MODEL);
  assert.ok(result);
  assert.equal(result.window, 'five_hour');
});

test('anthropicResetFromBody returns null for missing data', () => {
  assert.equal(anthropicResetFromBody({}, MODEL), null);
  assert.equal(anthropicResetFromBody({ five_hour: {} }, MODEL), null);
});

test('fetchAnthropicReset returns reset from usage API', async () => {
  const resetDate = new Date(NOW + 7200_000).toISOString();
  const fakeFetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ five_hour: { resets_at: resetDate } }),
  });
  const result = await fetchAnthropicReset({
    token: 'test',
    modelId: MODEL,
    fetchImpl: fakeFetch,
    now: NOW,
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.ok(Math.abs(result.reset.at - (NOW + 7200_000)) < 1000);
    assert.equal(result.reset.source, 'usage-api');
  }
});

test('fetchAnthropicReset handles 403 with helpful message', async () => {
  const fakeFetch: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const result = await fetchAnthropicReset({
    token: 'api-key',
    modelId: MODEL,
    fetchImpl: fakeFetch,
    now: NOW,
  });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.error.includes('OAuth'));
  }
});

test('fetchAnthropicReset handles network error', async () => {
  const fakeFetch: FetchLike = async () => {
    throw new Error('timeout');
  };
  const result = await fetchAnthropicReset({
    token: 'test',
    modelId: MODEL,
    fetchImpl: fakeFetch,
    now: NOW,
  });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.error.includes('timeout'));
  }
});
