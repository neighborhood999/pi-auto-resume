import { decodeJwtPayload, defaultFetch, errText, num, pick, type FetchDeps } from './client.ts';
import type { ResetInfo, UsageResult } from './types.ts';

const CODEX_PATTERNS = [
  /hit your ChatGPT usage limit/i,
  /the usage limit has been reached/i,
  /usage limit reached/i,
];

const CODEX_CODES = ['usage_limit_reached', 'rate_limit_exceeded'];

export function isCodexUsageLimit(errorMessage: string, status: number | undefined): boolean {
  if (status === 429) {
    return true;
  }
  for (const pattern of CODEX_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return true;
    }
  }
  for (const code of CODEX_CODES) {
    if (errorMessage.includes(code)) {
      return true;
    }
  }
  return false;
}

export function parseCodexHeaders(
  headers: Record<string, string>,
  now: number,
): number | undefined {
  const resetsAt = headers['x-ratelimit-reset'] ?? headers['x-ratelimit-reset-tokens'];
  if (resetsAt) {
    const epoch = Number(resetsAt);
    if (Number.isFinite(epoch) && epoch > 0) {
      const milliseconds = epoch > 1e12 ? epoch : epoch * 1000;
      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
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

export function parseCodexErrorBody(errorMessage: string, now: number): number | undefined {
  const match = errorMessage.match(/try again in ~?(\d+)\s*min/i);
  if (match?.[1]) {
    const minutes = Number(match[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      const resetAt = now + minutes * 60 * 1000;
      return Number.isFinite(resetAt) && resetAt > 0 ? resetAt : undefined;
    }
  }

  const epochMatch = errorMessage.match(/resets_at[:\s]*(\d{10,13})/i);
  if (epochMatch?.[1]) {
    const epoch = Number(epochMatch[1]);
    if (Number.isFinite(epoch) && epoch > 0) {
      const milliseconds = epoch > 1e12 ? epoch : epoch * 1000;
      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
    }
  }

  return undefined;
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export function codexAccountId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return undefined;
  }

  const auth = payload['https://api.openai.com/auth'];
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>)['chatgpt_account_id'];
    if (typeof id === 'string' && id.length > 0) {
      return id;
    }
  }

  for (const key of ['chatgpt_account_id', 'account_id']) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

export function codexResetFromBody(body: unknown, now: number): ResetInfo | null {
  const primary = pick(pick(body, 'rate_limit'), 'primary_window');
  const resetAt = num(pick(primary, 'reset_at'));
  if (resetAt !== null && resetAt > 0) {
    const milliseconds = resetAt > 1e12 ? resetAt : resetAt * 1000;
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      return {
        at: milliseconds,
        source: 'usage-api',
        window: 'primary_window',
      };
    }
  }

  const resetAfter = num(pick(primary, 'reset_after_seconds'));
  if (resetAfter !== null && resetAfter > 0) {
    const at = now + resetAfter * 1000;
    if (Number.isFinite(at) && at > 0) {
      return { at, source: 'usage-api', window: 'primary_window' };
    }
  }

  return null;
}

export async function fetchCodexReset(args: { token: string } & FetchDeps): Promise<UsageResult> {
  const now = args.now ?? Date.now();
  const doFetch = args.fetchImpl ?? defaultFetch();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.token}`,
    'User-Agent': 'pi-auto-resume',
  };
  const accountId = codexAccountId(args.token);
  if (accountId) {
    headers['ChatGPT-Account-Id'] = accountId;
  }

  let res;
  try {
    res = await doFetch(CODEX_USAGE_URL, { headers, signal: args.signal });
  } catch (error) {
    return { ok: false, error: `Codex usage request failed: ${errText(error)}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Codex usage API rejected the token (401/403).' };
  }
  if (!res.ok) {
    return { ok: false, error: `Codex usage API returned HTTP ${res.status}.` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: 'Codex usage API returned invalid JSON.' };
  }

  const reset = codexResetFromBody(body, now);
  if (!reset) {
    return { ok: false, error: 'Codex usage response carried no reset time.' };
  }

  return { ok: true, reset };
}
