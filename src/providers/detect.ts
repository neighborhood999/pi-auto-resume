import { isAnthropicUsageLimit, parseAnthropicHeaders } from './anthropic.ts';
import { isCodexUsageLimit, parseCodexErrorBody, parseCodexHeaders } from './codex.ts';
import { parseClaudeBridgeReset } from './claude-bridge.ts';
import type { ProviderFamily, UsageLimitHit, UsageLimitWindow } from './types.ts';

export type { UsageLimitHit } from './types.ts';

/** An empty retry is not evidence of recovery. */
export type RunEndObservation =
  | {
      readonly _tag: 'Error';
      readonly provider: string;
      readonly errorMessage: string;
      readonly resetsAt: number | undefined;
      /** Epoch milliseconds at failure, not settlement. */
      readonly failedAt: number;
    }
  | { readonly _tag: 'Empty' }
  | { readonly _tag: 'NonError' };

/** Correlates usage-limit failures across retries until settlement. */
export type UsageLimitDetector = {
  /** Fresh headers per attempt; empty retries may retain the preceding limit. */
  onRunStart(): void;
  /** Record this attempt's 429 headers. */
  onProviderResponse(
    provider: string,
    status: number,
    headers: Record<string, string>,
    at: number,
  ): void;
  /** Anchor classification to failedAt, before retry delays. */
  onRunEnd(observation: RunEndObservation): void;
  consumeSettledLimit(): UsageLimitHit | undefined;
  /** Discard observations on genuine recovery or a session/exact-model change. */
  reset(): void;
};

type RateLimitEvidence = {
  readonly provider: string;
  readonly family: ProviderFamily;
  readonly headers: Record<string, string>;
  readonly at: number;
};

type DetectorRunState =
  | { readonly _tag: 'Running'; readonly previousHit: UsageLimitHit | undefined }
  | { readonly _tag: 'Ended'; readonly hit: UsageLimitHit | undefined };

const NON_RESUMABLE_PATTERNS = [
  /billing/i,
  /quota.*exhaust/i,
  /insufficient.*balance/i,
  /plan does not include/i,
  /credit/i,
  /usage_not_included/,
];

const EVIDENCE_FRESHNESS_MS = 600_000;
const FIVE_HOURS_MS = 5 * 3_600_000;

/** Classify usage-limit semantics without changing the exact provider/model resume target. */
export function providerFamily(provider: string): ProviderFamily | null {
  if (provider === 'openai-codex') {
    return 'codex';
  }
  if (provider === 'anthropic' || provider === 'claude-bridge') {
    return 'anthropic';
  }
  return null;
}

/** Isolated usage-limit detection across automatic retries. */
export function createUsageLimitDetector(): UsageLimitDetector {
  let evidence: RateLimitEvidence | undefined;
  let runState: DetectorRunState = { _tag: 'Running', previousHit: undefined };

  function previousHit(): UsageLimitHit | undefined {
    return runState._tag === 'Ended' ? runState.hit : runState.previousHit;
  }

  function reset(): void {
    evidence = undefined;
    runState = { _tag: 'Running', previousHit: undefined };
  }

  return {
    reset,

    onRunStart() {
      runState = { _tag: 'Running', previousHit: previousHit() };
      evidence = undefined;
    },

    onProviderResponse(provider, status, headers, at) {
      if (status !== 429) {
        return;
      }
      const family = providerFamily(provider);
      if (!family) {
        return;
      }
      const normalizedHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(headers)) {
        normalizedHeaders[name.toLowerCase()] = value;
      }
      evidence = { provider, family, headers: normalizedHeaders, at };
    },

    onRunEnd(observation) {
      switch (observation._tag) {
        case 'NonError':
          runState = { _tag: 'Ended', hit: undefined };
          break;
        case 'Empty':
          runState = { _tag: 'Ended', hit: previousHit() };
          break;
        case 'Error':
          runState = {
            _tag: 'Ended',
            hit: classifyUsageLimitFailure(observation, evidence, observation.failedAt),
          };
          break;
      }
      evidence = undefined;
    },

    consumeSettledLimit() {
      const hit = runState._tag === 'Ended' ? runState.hit : undefined;
      reset();
      return hit;
    },
  };
}

function classifyUsageLimitFailure(
  error: Extract<RunEndObservation, { readonly _tag: 'Error' }>,
  evidence: RateLimitEvidence | undefined,
  now: number,
): UsageLimitHit | undefined {
  if (isNonResumable(error.errorMessage)) {
    return undefined;
  }

  const family = providerFamily(error.provider);
  if (!family) {
    return undefined;
  }

  const fresh =
    evidence && evidence.provider === error.provider && now - evidence.at < EVIDENCE_FRESHNESS_MS
      ? evidence
      : undefined;

  const freshStatus = fresh ? 429 : undefined;

  const isLimit =
    family === 'codex'
      ? isCodexUsageLimit(error.errorMessage, freshStatus)
      : isAnthropicUsageLimit(error.errorMessage, freshStatus);

  if (!isLimit) {
    return undefined;
  }

  if (error.resetsAt !== undefined) {
    return {
      provider: family,
      resetAt: error.resetsAt,
      source: 'metadata',
      window: windowFromResetDistance(error.resetsAt, now),
    };
  }

  const headerReset =
    fresh &&
    (family === 'codex'
      ? parseCodexHeaders(fresh.headers, fresh.at)
      : parseAnthropicHeaders(fresh.headers, fresh.at));

  if (headerReset) {
    return {
      provider: family,
      resetAt: headerReset,
      source: 'header',
      window: windowFromResetDistance(headerReset, now),
    };
  }

  const isBridge = error.provider === 'claude-bridge';
  const bodyReset = isBridge
    ? parseClaudeBridgeReset(error.errorMessage, now)
    : family === 'codex'
      ? parseCodexErrorBody(error.errorMessage, now)
      : undefined;
  if (bodyReset !== undefined) {
    return {
      provider: family,
      resetAt: bodyReset,
      source: 'body',
      window: isBridge ? 'five_hour' : windowFromResetDistance(bodyReset, now),
    };
  }

  return { provider: family, resetAt: undefined };
}

function windowFromResetDistance(resetAt: number, now: number): UsageLimitWindow | undefined {
  return resetAt - now > FIVE_HOURS_MS ? 'weekly' : undefined;
}

function isNonResumable(errorMessage: string): boolean {
  for (const pattern of NON_RESUMABLE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return true;
    }
  }
  return false;
}
