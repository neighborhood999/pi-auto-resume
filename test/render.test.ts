import assert from 'node:assert/strict';
import test from 'node:test';

import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';

import {
  formatAbsoluteDate,
  formatFooterStatus,
  hhmm,
  renderResumeCountdown,
} from '../src/render.ts';
import type { ResumeScheduleState } from '../src/schedule.ts';

const IDENTITY_THEME = {
  fg: (_color: string, text: string) => text,
};

const NOW = 1_700_000_000_000;

test('formatAbsoluteDate formats as Mon D, HH:MM', () => {
  const d = new Date(2026, 8, 22, 0, 0, 0);
  assert.equal(formatAbsoluteDate(d.getTime()), 'Sep 22, 00:00');
});

test('hhmm formats hours and minutes', () => {
  const d = new Date(2024, 0, 1, 14, 5, 0);
  assert.equal(hhmm(d.getTime()), '14:05');
});

test('render waiting state with known reset', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'codex', resetAt: NOW + 3600_000 },
    wakeAt: NOW + 3645_000,
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, 'claude · opus-4-7');
  const text = lines.join('\n');
  assert.ok(text.includes('⏸ Reached Usage Limit'));
  assert.ok(text.includes('resumes at'));
  assert.ok(text.includes('claude · opus-4-7'));
  const expectedWidth = visibleWidth(stripTerminalSequences(lines[0]!));
  for (const line of lines) {
    assert.equal(visibleWidth(stripTerminalSequences(line)), expectedWidth);
  }
});

test('render waiting state with unknown reset', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'anthropic', resetAt: undefined },
    wakeAt: NOW + 600_000,
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, 'anthropic · claude');
  const text = lines.join('\n');
  assert.ok(text.includes('Unknown reset time'));
  assert.ok(text.includes('next check in 10 min'));
});

test('render resuming state', () => {
  const state: ResumeScheduleState = {
    phase: 'resuming',
    hit: { provider: 'codex', resetAt: NOW + 3600_000 },
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, 'claude · opus-4-7');
  const text = lines.join('\n');
  assert.ok(text.includes('checking limit'));
});

test('formatFooterStatus for waiting with known reset', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'codex', resetAt: NOW + 3600_000 },
    wakeAt: NOW + 3645_000,
    attempt: 1,
  };
  const status = formatFooterStatus(state);
  assert.ok(status);
  assert.ok(status.includes('⏸ limit'));
  assert.ok(status.includes('resumes'));
});

test('formatFooterStatus for waiting with unknown reset', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'anthropic', resetAt: undefined },
    wakeAt: NOW + 600_000,
    attempt: 1,
  };
  const status = formatFooterStatus(state);
  assert.ok(status);
  assert.ok(status.includes('unknown'));
});

test('formatFooterStatus for idle returns undefined', () => {
  assert.equal(formatFooterStatus({ phase: 'idle' }), undefined);
});

test('formatFooterStatus for resuming', () => {
  const state: ResumeScheduleState = {
    phase: 'resuming',
    hit: { provider: 'codex', resetAt: NOW },
    attempt: 2,
  };
  const status = formatFooterStatus(state);
  assert.ok(status);
  assert.ok(status.includes('checking'));
});

test('render waiting state with ≥24h shows absolute date', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'codex', resetAt: NOW + 100_000_000 },
    wakeAt: NOW + 100_000_000,
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, 'claude · opus-4-7');
  const text = lines.join('\n');
  assert.ok(text.includes('resumes at'));
  assert.ok(!text.includes('in '), 'should not show relative time for ≥24h');
  const expectedWidth = visibleWidth(stripTerminalSequences(lines[0]!));
  for (const line of lines) {
    assert.equal(visibleWidth(stripTerminalSequences(line)), expectedWidth);
  }
});

test('fixed overlay truncates long model labels by visible width', () => {
  const longLabel = 'openai-codex · gpt-5.6-luna-with-a-very-long-name (medium) and extra details';
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'codex', resetAt: NOW + 3600_000 },
    wakeAt: NOW + 3645_000,
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, longLabel);
  const text = lines.join('\n');
  assert.ok(!text.includes(longLabel), 'label should be truncated');
  const expectedWidth = visibleWidth(stripTerminalSequences(lines[0]!));
  assert.equal(expectedWidth, 46);
  for (const line of lines) {
    assert.ok(visibleWidth(stripTerminalSequences(line)) <= 46);
    assert.equal(visibleWidth(stripTerminalSequences(line)), expectedWidth);
  }
});

test('relative countdown uses minutes then seconds in the final minute', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'codex', resetAt: NOW + 60_000 },
    wakeAt: NOW + 42_000,
    attempt: 1,
  };
  const lines = renderResumeCountdown(state, IDENTITY_THEME, NOW, 0, 'codex · gpt');
  assert.ok(lines.join('\\n').includes('in 42s'));

  const minutes = renderResumeCountdown(
    { ...state, wakeAt: NOW + 2 * 60_000 + 1 },
    IDENTITY_THEME,
    NOW,
    0,
    'codex · gpt',
  );
  assert.ok(minutes.join('\\n').includes('in 3 min'));
});

test('all rendered lines have consistent width', () => {
  const state: ResumeScheduleState = {
    phase: 'waiting',
    hit: { provider: 'anthropic', resetAt: undefined },
    wakeAt: NOW + 600_000,
    attempt: 3,
  };
  const lines = renderResumeCountdown(
    state,
    IDENTITY_THEME,
    NOW,
    2,
    'anthropic · claude-opus-4-7 (max)',
  );
  for (const line of lines) {
    assert.equal(
      visibleWidth(stripTerminalSequences(line)),
      visibleWidth(stripTerminalSequences(lines[0]!)),
      `Line width mismatch: "${stripTerminalSequences(line)}"`,
    );
  }
});
