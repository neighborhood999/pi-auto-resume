import { defaultFetch, errText, parseEpochOrIso, pick, type FetchDeps } from './client.ts';
import type { ResetInfo, UsageLimitWindow, UsageResult } from './types.ts';

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

type AnthropicBucket = {
  readonly key: string;
  readonly window: UsageLimitWindow;
  readonly appliesTo?: (modelId: string) => boolean;
};

const FIVE_HOUR_BUCKET: AnthropicBucket = { key: 'five_hour', window: 'five_hour' };
const SEVEN_DAY_BUCKET: AnthropicBucket = { key: 'seven_day', window: 'weekly' };

const ANTHROPIC_BUCKETS: readonly AnthropicBucket[] = [
  FIVE_HOUR_BUCKET,
  SEVEN_DAY_BUCKET,
  { key: 'seven_day_opus', window: 'weekly', appliesTo: (modelId) => /opus/i.test(modelId) },
  { key: 'seven_day_sonnet', window: 'weekly', appliesTo: (modelId) => /sonnet/i.test(modelId) },
];

export function anthropicResetFromBody(body: unknown, modelId: string): ResetInfo | null {
  let blocking: ResetInfo | null = null;
  for (const bucket of ANTHROPIC_BUCKETS) {
    if (bucket.appliesTo && !bucket.appliesTo(modelId)) {
      continue;
    }
    if (!isBucketExhausted(body, bucket)) {
      continue;
    }
    const reset = bucketReset(body, bucket);
    if (!reset) {
      return null;
    }
    if (!blocking || reset.at > blocking.at) {
      blocking = reset;
    }
  }

  return blocking ?? bucketReset(body, FIVE_HOUR_BUCKET) ?? bucketReset(body, SEVEN_DAY_BUCKET);
}

function bucketReset(body: unknown, bucket: AnthropicBucket): ResetInfo | null {
  const resetsAt = pick(pick(body, bucket.key), 'resets_at');
  if (typeof resetsAt !== 'string') {
    return null;
  }
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return { at: ms, source: 'usage-api', window: bucket.window };
}

function isBucketExhausted(body: unknown, bucket: AnthropicBucket): boolean {
  const utilization = pick(pick(body, bucket.key), 'utilization');
  return typeof utilization === 'number' && utilization >= 100;
}

export async function fetchAnthropicReset(
  args: { token: string; modelId: string; userAgent?: string | undefined } & FetchDeps,
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

  const reset = anthropicResetFromBody(body, args.modelId);
  if (!reset) {
    return { ok: false, error: 'Anthropic usage response carried no usable reset time.' };
  }

  return { ok: true, reset };
}
