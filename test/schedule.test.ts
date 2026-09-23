import assert from 'node:assert/strict';
import test from 'node:test';

import type { UsageLimitHit } from '../src/providers/types.ts';
import {
  DEFAULT_CONFIG,
  nextResumeScheduleState,
  type ResumeScheduleState,
} from '../src/schedule.ts';

const NOW = 1_700_000_000_000;
const HIT: UsageLimitHit = { provider: 'codex', resetAt: NOW + 3600_000 };
const HIT_UNKNOWN: UsageLimitHit = { provider: 'anthropic', resetAt: undefined };
const IDLE: ResumeScheduleState = { phase: 'idle' };

test('limit from idle → waiting with attempt 1', () => {
  const state = nextResumeScheduleState(IDLE, { type: 'limit', hit: HIT }, NOW, DEFAULT_CONFIG);
  assert.equal(state.phase, 'waiting');
  if (state.phase !== 'waiting') {
    return;
  }
  assert.equal(state.attempt, 1);
  assert.equal(state.wakeAt, HIT.resetAt! + DEFAULT_CONFIG.bufferMs);
  assert.deepEqual(state.hit, HIT);
});

test('limit with unknown reset → wakeAt uses pollIntervalMs', () => {
  const state = nextResumeScheduleState(
    IDLE,
    { type: 'limit', hit: HIT_UNKNOWN },
    NOW,
    DEFAULT_CONFIG,
  );
  assert.equal(state.phase, 'waiting');
  if (state.phase !== 'waiting') {
    return;
  }
  assert.equal(state.wakeAt, NOW + DEFAULT_CONFIG.pollIntervalMs);
});

test('wake while waiting → resuming', () => {
  const waiting: ResumeScheduleState = {
    phase: 'waiting',
    hit: HIT,
    wakeAt: NOW + 100_000,
    attempt: 1,
  };
  const state = nextResumeScheduleState(waiting, { type: 'wake' }, NOW, DEFAULT_CONFIG);
  assert.equal(state.phase, 'resuming');
  if (state.phase !== 'resuming') {
    return;
  }
  assert.equal(state.attempt, 1);
});

test('restore keeps persisted attempt, hit, and wake time', () => {
  const wakeAt = NOW + 12_345;
  const state = nextResumeScheduleState(
    IDLE,
    {
      type: 'restore',
      hit: HIT_UNKNOWN,
      wakeAt,
      attempt: 5,
    },
    NOW,
    DEFAULT_CONFIG,
  );
  assert.deepEqual(state, {
    phase: 'waiting',
    hit: HIT_UNKNOWN,
    wakeAt,
    attempt: 5,
  });
});

test('restore beyond max attempts gives up', () => {
  const state = nextResumeScheduleState(
    IDLE,
    { type: 'restore', hit: HIT, wakeAt: NOW, attempt: 7 },
    NOW,
    { ...DEFAULT_CONFIG, maxAttempts: 6 },
  );
  assert.deepEqual(state, IDLE);
});

test('settled-ok from any phase → idle', () => {
  const waiting: ResumeScheduleState = {
    phase: 'waiting',
    hit: HIT,
    wakeAt: NOW + 100_000,
    attempt: 1,
  };
  const s1 = nextResumeScheduleState(waiting, { type: 'settled-ok' }, NOW, DEFAULT_CONFIG);
  assert.equal(s1.phase, 'idle');

  const resuming: ResumeScheduleState = { phase: 'resuming', hit: HIT, attempt: 1 };
  const s2 = nextResumeScheduleState(resuming, { type: 'settled-ok' }, NOW, DEFAULT_CONFIG);
  assert.equal(s2.phase, 'idle');

  const s3 = nextResumeScheduleState(IDLE, { type: 'settled-ok' }, NOW, DEFAULT_CONFIG);
  assert.equal(s3.phase, 'idle');
});

test('limit while resuming → waiting with attempt+1', () => {
  const resuming: ResumeScheduleState = { phase: 'resuming', hit: HIT, attempt: 2 };
  const newHit: UsageLimitHit = { provider: 'codex', resetAt: NOW + 7200_000 };
  const state = nextResumeScheduleState(
    resuming,
    { type: 'limit', hit: newHit },
    NOW,
    DEFAULT_CONFIG,
  );
  assert.equal(state.phase, 'waiting');
  if (state.phase !== 'waiting') {
    return;
  }
  assert.equal(state.attempt, 3);
  assert.deepEqual(state.hit, newHit);
});

test('limit while waiting re-derives wakeAt without incrementing attempt', () => {
  const waiting: ResumeScheduleState = {
    phase: 'waiting',
    hit: HIT,
    wakeAt: NOW + 100_000,
    attempt: 2,
  };
  const newHit: UsageLimitHit = { provider: 'codex', resetAt: NOW + 5000_000 };
  const state = nextResumeScheduleState(
    waiting,
    { type: 'limit', hit: newHit },
    NOW,
    DEFAULT_CONFIG,
  );
  assert.equal(state.phase, 'waiting');
  if (state.phase !== 'waiting') {
    return;
  }
  assert.equal(state.attempt, 2);
  assert.equal(state.wakeAt, newHit.resetAt! + DEFAULT_CONFIG.bufferMs);
});

test('max attempts exceeded → idle', () => {
  const config = { ...DEFAULT_CONFIG, maxAttempts: 2 };
  const resuming: ResumeScheduleState = { phase: 'resuming', hit: HIT, attempt: 2 };
  const state = nextResumeScheduleState(resuming, { type: 'limit', hit: HIT }, NOW, config);
  assert.equal(state.phase, 'idle');
});

test('cancel → idle', () => {
  const waiting: ResumeScheduleState = {
    phase: 'waiting',
    hit: HIT,
    wakeAt: NOW + 100_000,
    attempt: 1,
  };
  const state = nextResumeScheduleState(waiting, { type: 'cancel' }, NOW, DEFAULT_CONFIG);
  assert.equal(state.phase, 'idle');
});

test('wake while idle is ignored', () => {
  const state = nextResumeScheduleState(IDLE, { type: 'wake' }, NOW, DEFAULT_CONFIG);
  assert.equal(state.phase, 'idle');
});

test('wake while resuming is ignored', () => {
  const resuming: ResumeScheduleState = { phase: 'resuming', hit: HIT, attempt: 1 };
  const state = nextResumeScheduleState(resuming, { type: 'wake' }, NOW, DEFAULT_CONFIG);
  assert.equal(state.phase, 'resuming');
});
