import { defaultFetch, errText, parseEpochOrIso, pick, type FetchDeps } from './client.ts';
import type { ResetInfo, UsageResult } from './types.ts';

export function isAnthropicUsageLimit(errorMessage: string, status: number | undefined): boolean {
  if (status === 429) {
    return true;
  }
  return /rate.?limit|rate_limit_error|usage limit|\b429\b/i.test(errorMessage);
}

export function parseAnthropicHeaders(
  headers: Record<string, string>,
  now: number,
): number | undefined {
  for (const key of ['anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-reset']) {
    const raw = headers[key];
    if (raw !== undefined) {
      const ms = parseEpochOrIso(raw);
      if (ms !== null) {
        return ms;
      }
    }
  }

  const retryAfter = headers['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      const resetAt = now + seconds * 1000;
      return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
    }
  }

  return undefined;
}

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const DEFAULT_USER_AGENT = 'claude-code/1.0.0';

export function anthropicResetFromBody(body: unknown): ResetInfo | null {
  const fiveHour = windowReset(body, 'five_hour');
  const weekly = windowReset(body, 'weekly');

  if (fiveHour && weekly) {
    const fiveHourExhausted = isWindowExhausted(body, 'five_hour');
    const weeklyExhausted = isWindowExhausted(body, 'weekly');

    if (fiveHourExhausted !== null || weeklyExhausted !== null) {
      const exhausted: ResetInfo[] = [];
      if (fiveHourExhausted === true) {
        exhausted.push(fiveHour);
      }
      if (weeklyExhausted === true) {
        exhausted.push(weekly);
      }

      if (exhausted.length > 0) {
        return exhausted.reduce((a, b) => (a.at <= b.at ? a : b));
      }
    }

    return fiveHour;
  }
  return fiveHour ?? weekly ?? null;
}

function windowReset(body: unknown, key: string): ResetInfo | null {
  const window = pick(body, key);
  const resetsAt = pick(window, 'resets_at');
  if (typeof resetsAt !== 'string') {
    return null;
  }
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return { at: ms, source: 'usage-api', window: key };
}

function isWindowExhausted(body: unknown, key: string): boolean | null {
  const window = pick(body, key);
  const utilization = pick(window, 'utilization');
  if (typeof utilization === 'number') {
    return utilization >= 100;
  }
  return null;
}

export async function fetchAnthropicReset(
  args: { token: string; userAgent?: string | undefined } & FetchDeps,
): Promise<UsageResult> {
  const doFetch = args.fetchImpl ?? defaultFetch();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': args.userAgent ?? DEFAULT_USER_AGENT,
  };

  let res;
  try {
    res = await doFetch(ANTHROPIC_USAGE_URL, { headers, signal: args.signal });
  } catch (error) {
    return { ok: false, error: `Anthropic usage request failed: ${errText(error)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: 'Anthropic usage API rejected the token (401/403). Needs OAuth login, not an API key.',
    };
  }
  if (!res.ok) {
    return { ok: false, error: `Anthropic usage API returned HTTP ${res.status}.` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: 'Anthropic usage API returned invalid JSON.' };
  }

  const reset = anthropicResetFromBody(body);
  if (!reset) {
    return { ok: false, error: 'Anthropic usage response carried no five_hour reset time.' };
  }

  return { ok: true, reset };
}
