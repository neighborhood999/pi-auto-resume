import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import type { ResumeScheduleState } from './schedule.ts';

type ResumeTheme = Pick<Theme, 'fg'>;

const MIN_BOX_WIDTH = 34;
const MAX_BOX_WIDTH = 46;
const BORDER = 2;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Liveness pulse glyphs cycled by the countdown component. */
export const PULSE = ['◐', '◓', '◑', '◒'] as const;

/**
 * Render the resume-countdown dialog as fixed-width terminal lines.
 *
 * The overlay is intentionally 46 columns wide. Long labels are truncated in
 * visible terminal columns rather than expanding the overlay or overflowing a
 * border.
 *
 * @param state - Current schedule state.
 * @param theme - Pi theme projection used for warning and muted text.
 * @param now - Current epoch in milliseconds.
 * @param pulseIndex - Liveness glyph index.
 * @param modelLabel - Display-only provider/model label.
 * @returns Fully padded dialog lines.
 */
export function renderResumeCountdown(
  state: ResumeScheduleState,
  theme: ResumeTheme,
  now: number,
  pulseIndex: number,
  modelLabel: string,
): string[] {
  const requestedInner = visibleWidth(modelLabel) + 2;
  const inner = Math.min(MAX_BOX_WIDTH - BORDER, Math.max(MIN_BOX_WIDTH - BORDER, requestedInner));
  const pulse = PULSE[pulseIndex % PULSE.length];
  const lines: string[] = [];
  const boundedModelLabel = truncateToWidth(modelLabel || 'unknown model', inner, '…');

  lines.push(topBorder(inner, theme.fg('warning', '⏸ Reached Usage Limit')));
  lines.push(emptyLine(inner));

  if (state.phase === 'resuming') {
    lines.push(bodyLine(inner, center(inner, `${pulse}  checking limit…`)));
    lines.push(emptyLine(inner));
  } else if (state.phase === 'waiting') {
    const remaining = state.wakeAt - now;
    if (state.hit.resetAt !== undefined) {
      if (remaining >= DAY_MS) {
        lines.push(bodyLine(inner, center(inner, `${pulse}  resumes at`)));
        lines.push(bodyLine(inner, center(inner, formatAbsoluteDate(state.wakeAt))));
      } else {
        lines.push(bodyLine(inner, center(inner, `${pulse}  resumes at ${hhmm(state.wakeAt)}`)));
        lines.push(bodyLine(inner, center(inner, relativeCountdown(remaining))));
      }
    } else {
      lines.push(bodyLine(inner, center(inner, `${pulse}  Unknown reset time`)));
      lines.push(
        bodyLine(inner, center(inner, `next check in ${relativeCountdown(remaining, true)}`)),
      );
    }
    lines.push(emptyLine(inner));
  } else {
    lines.push(emptyLine(inner));
    lines.push(emptyLine(inner));
  }

  lines.push(bodyLine(inner, center(inner, theme.fg('muted', boundedModelLabel))));
  lines.push(bottomBorder(inner));
  return lines;
}

/** Format a one-line footer status string, or `undefined` when idle. */
export function formatFooterStatus(state: ResumeScheduleState): string | undefined {
  if (state.phase === 'waiting' && state.hit.resetAt !== undefined) {
    const remaining = state.wakeAt - Date.now();
    if (remaining >= DAY_MS) {
      return `⏸ limit · resumes ${formatAbsoluteDate(state.wakeAt)}`;
    }
    return `⏸ limit · resumes ${hhmm(state.wakeAt)} · ${relativeCountdown(remaining)}`;
  }
  if (state.phase === 'waiting') {
    return `⏸ limit · reset time unknown · next check in ${relativeCountdown(state.wakeAt - Date.now(), true)}`;
  }
  if (state.phase === 'resuming') {
    return '⏸ limit · checking…';
  }
  return undefined;
}

/** Format an epoch as `HH:MM` in the local timezone. */
export function hhmm(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Format an epoch as `Mon D, HH:MM` in the local timezone. */
export function formatAbsoluteDate(epochMs: number): string {
  const date = new Date(epochMs);
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${month} ${date.getDate()}, ${hhmm(epochMs)}`;
}

/**
 * Format a countdown at minute granularity until its final minute, then in
 * seconds. Negative durations are clamped to zero.
 *
 * @param milliseconds - Duration remaining in milliseconds.
 * @param bare - Omit the leading `in` for embedding in a sentence.
 * @returns A human-readable countdown.
 */
export function relativeCountdown(milliseconds: number, bare = false): string {
  const remaining = Math.max(0, milliseconds);
  if (remaining > MINUTE_MS) {
    const minutes = Math.ceil(remaining / MINUTE_MS);
    return bare ? `${minutes} min` : `in ${minutes} min`;
  }
  const seconds = Math.ceil(remaining / 1000);
  return bare ? `${seconds}s` : `in ${seconds}s`;
}

function center(inner: number, content: string): string {
  const bounded = truncateToWidth(content, inner, '…');
  const gap = Math.max(0, inner - visibleWidth(bounded));
  return `${' '.repeat(Math.floor(gap / 2))}${bounded}`;
}

function bodyLine(inner: number, content: string): string {
  const bounded = truncateToWidth(content, inner, '…');
  const gap = Math.max(0, inner - visibleWidth(bounded));
  return `│${bounded}${' '.repeat(gap)}│`;
}

function emptyLine(inner: number): string {
  return `│${' '.repeat(inner)}│`;
}

function topBorder(inner: number, title: string): string {
  const label = truncateToWidth(`─ ${title} `, inner, '…');
  const fill = Math.max(0, inner - visibleWidth(label));
  return `┌${label}${'─'.repeat(fill)}┐`;
}

function bottomBorder(inner: number): string {
  return `└${'─'.repeat(inner)}┘`;
}
