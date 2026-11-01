import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageLimitDetector } from '../src/providers/detect.ts';

const NOW = 1_700_000_000_000;
const RESET = NOW + 3_600_000;

function diagnostic(details: unknown, timestamp: unknown = NOW): unknown {
  return { type: 'pi-claude-cli.rate-limit', timestamp, details };
}

function detect(diagnostics: unknown, errorMessage = '', provider = 'pi-claude-cli') {
  const detector = createUsageLimitDetector();
  detector.onRunEnd({
    _tag: 'Error',
    provider,
    errorMessage,
    resetsAt: undefined,
    failedAt: NOW,
    diagnostics,
  });
  return detector.consumeSettledLimit();
}

test('Claude CLI rejected diagnostics classify independently of error wording', () => {
  for (const [rateLimitType, window] of [
    ['five_hour', 'five_hour'],
    ['seven_day', 'weekly'],
    ['seven_day_opus', 'weekly'],
    ['unknown', undefined],
  ]) {
    assert.deepEqual(
      detect([diagnostic({ status: 'rejected', rateLimitType, resetsAt: RESET / 1000 })]),
      {
        provider: 'anthropic',
        resetAt: RESET,
        source: 'metadata',
        window,
      },
    );
  }
});

test('Claude CLI missing or invalid resets keep a confirmed limit unknown', () => {
  for (const resetsAt of [undefined, null, '1700003600', NaN, Infinity, -1, NOW / 1000, 1e300]) {
    assert.deepEqual(detect([diagnostic({ status: 'rejected', resetsAt })]), {
      provider: 'anthropic',
      resetAt: undefined,
    });
  }
});

test('Claude CLI ignores stale, future, malformed, allowed and overage diagnostics', () => {
  const rejected = { status: 'rejected', resetsAt: RESET / 1000 };
  for (const diagnostics of [
    undefined,
    null,
    {},
    [null],
    [diagnostic(null)],
    [diagnostic(rejected, NOW - 600_000)],
    [diagnostic(rejected, NOW + 1)],
    [diagnostic(rejected, NaN)],
    [diagnostic(rejected, 'now')],
    [diagnostic({ ...rejected, status: 'allowed' })],
    [diagnostic({ ...rejected, status: 'allowed_warning' })],
    [diagnostic({ ...rejected, isUsingOverage: true })],
    [diagnostic(rejected), diagnostic({ ...rejected, status: 'allowed' })],
  ]) {
    assert.equal(detect(diagnostics), undefined);
  }
  assert.equal(detect([diagnostic(rejected)], '', 'anthropic'), undefined);
});

test('Claude CLI billing and credit errors remain non-resumable even with diagnostics', () => {
  for (const message of [
    'Claude billing: usage rejected',
    'Insufficient credits',
    'Your plan does not include this feature',
  ]) {
    assert.equal(
      detect([diagnostic({ status: 'rejected', resetsAt: RESET / 1000 })], message),
      undefined,
    );
  }
});

test('Claude CLI error text still detects limits when diagnostics are unavailable', () => {
  assert.deepEqual(detect(undefined, 'rate_limit_error'), {
    provider: 'anthropic',
    resetAt: undefined,
  });
});
