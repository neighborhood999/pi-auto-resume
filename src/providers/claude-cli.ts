import { pick } from './client.ts';
import type { UsageLimitHit, UsageLimitWindow } from './types.ts';

const DIAGNOSTIC_FRESHNESS_MS = 600_000;

/** Parse a fresh rejected Claude CLI rate limit; diagnostic reset epochs are Unix seconds. */
export function parseClaudeCliLimit(diagnostics: unknown, now: number): UsageLimitHit | undefined {
  if (!Array.isArray(diagnostics) || !Number.isFinite(now)) {
    return undefined;
  }
  // The provider retains one diagnostic of this type. Prefer the latest if a
  // future version appends them, so an earlier rejection cannot beat recovery.
  const diagnostic: unknown = [...diagnostics]
    .reverse()
    .find((entry: unknown) => pick(entry, 'type') === 'pi-claude-cli.rate-limit');
  const timestamp = pick(diagnostic, 'timestamp');
  const details = pick(diagnostic, 'details');
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp > now ||
    now - timestamp >= DIAGNOSTIC_FRESHNESS_MS ||
    pick(details, 'status') !== 'rejected' ||
    pick(details, 'isUsingOverage') === true
  ) {
    return undefined;
  }

  const seconds = pick(details, 'resetsAt');
  const resetAt = typeof seconds === 'number' ? seconds * 1000 : NaN;
  if (!Number.isSafeInteger(resetAt) || resetAt <= now || resetAt > 8.64e15) {
    return { provider: 'anthropic', resetAt: undefined };
  }

  const rateLimitType = pick(details, 'rateLimitType');
  const window: UsageLimitWindow | undefined =
    rateLimitType === 'five_hour'
      ? 'five_hour'
      : typeof rateLimitType === 'string' && /^seven_day(?:_|$)/.test(rateLimitType)
        ? 'weekly'
        : undefined;
  return { provider: 'anthropic', resetAt, source: 'metadata', window };
}
