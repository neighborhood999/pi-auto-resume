import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PENDING_SCHEMA_VERSION,
  parsePendingResumeState,
  pendingResumeEntryData,
} from '../src/pending.ts';

const VALID = {
  schemaVersion: PENDING_SCHEMA_VERSION,
  provider: 'anthropic',
  modelId: 'claude-opus',
  model: 'Claude Opus',
  family: 'anthropic',
  resetAt: 1_700_000_000_000,
  source: 'usage-api',
  wakeAt: 1_700_000_045_000,
  attempt: 4,
};

test('pending schema parses and round-trips the latest attempt', () => {
  const parsed = parsePendingResumeState(VALID);
  assert.ok(parsed.ok);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.state.attempt, 4);
  assert.equal(parsed.state.wakeAt, VALID.wakeAt);
  assert.deepEqual(pendingResumeEntryData(parsed.state), VALID);
});

test('pending parser accepts legacy unversioned entries', () => {
  const { schemaVersion: _schemaVersion, ...legacy } = VALID;
  const parsed = parsePendingResumeState(legacy);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.equal(parsed.state.schemaVersion, PENDING_SCHEMA_VERSION);
  }
});

test('pending parser marks a known reset without a recorded source as unrecorded', () => {
  const { source: _source, ...unsourced } = VALID;
  const parsed = parsePendingResumeState(unsourced);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.state.hit, {
      provider: 'anthropic',
      resetAt: VALID.resetAt,
      source: 'unrecorded',
    });
  }
});

test('pending parser keeps an unknown reset without a source', () => {
  const { source: _source, resetAt: _resetAt, ...unknownReset } = VALID;
  const parsed = parsePendingResumeState(unknownReset);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    assert.deepEqual(parsed.state.hit, { provider: 'anthropic', resetAt: undefined });
    assert.equal(pendingResumeEntryData(parsed.state)['source'], undefined);
  }
});

test('pending parser rejects mismatched schema and invalid numbers', () => {
  assert.equal(parsePendingResumeState({ ...VALID, schemaVersion: 2 }).ok, false);
  assert.equal(parsePendingResumeState({ ...VALID, wakeAt: Infinity }).ok, false);
  assert.equal(parsePendingResumeState({ ...VALID, resetAt: 0 }).ok, false);
  assert.equal(parsePendingResumeState({ ...VALID, attempt: 1.5 }).ok, false);
  assert.equal(parsePendingResumeState({ ...VALID, attempt: 0 }).ok, false);
  assert.equal(parsePendingResumeState({ ...VALID, source: 'guess' }).ok, false);
});

test('pending parser preserves the provider family for target mapping checks', () => {
  const parsed = parsePendingResumeState({ ...VALID, family: 'codex' });
  assert.ok(parsed.ok);
  // The family is structurally valid here; the exact provider/family mapping
  // is an ExtensionAPI boundary concern and is checked before re-arm.
  if (parsed.ok) {
    assert.equal(parsed.state.hit.provider, 'codex');
  }
});
