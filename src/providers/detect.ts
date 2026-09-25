import { isAnthropicUsageLimit, parseAnthropicHeaders } from './anthropic.ts';
import { isCodexUsageLimit, parseCodexErrorBody, parseCodexHeaders } from './codex.ts';
import type { ProviderFamily, UsageLimitHit } from './types.ts';

export type { UsageLimitHit } from './types.ts';

export type RunEndObservation =
  | {
      readonly _tag: 'Error';
      readonly provider: string;
      readonly errorMessage: string;
      readonly resetsAt: number | undefined;
    }
  | { readonly _tag: 'NonError' };

export type UsageLimitDetector = {
  /** Start an isolated Pi agent attempt (including an automatic retry). */
  onRunStart(): void;
  onProviderResponse(
    provider: string,
    status: number,
    headers: Record<string, string>,
    at: number,
  ): void;
  onRunEnd(observation: RunEndObservation): void;
  classify(now: number): UsageLimitHit | undefined;
};

type RateLimitEvidence = {
  readonly provider: string;
  readonly family: ProviderFamily;
  readonly headers: Record<string, string>;
  readonly at: number;
};

const NON_RESUMABLE_PATTERNS = [
  /billing/i,
  /quota.*exhaust/i,
  /insufficient.*balance/i,
  /plan does not include/i,
  /credit/i,
  /usage_not_included/,
];

const EVIDENCE_FRESHNESS_MS = 600_000;

export function providerFamily(provider: string): ProviderFamily | null {
  if (provider === 'openai-codex') {
    return 'codex';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return null;
}

export function createUsageLimitDetector(): UsageLimitDetector {
  let evidence: RateLimitEvidence | undefined;
  let runError:
    | { provider: string; errorMessage: string; resetsAt: number | undefined }
    | undefined;

  return {
    onRunStart() {
      // Pi emits agent_start for every agentLoop/agentLoopContinue invocation,
      // including automatic retries. Evidence and the terminal observation must
      // never cross that boundary.
      evidence = undefined;
      runError = undefined;
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
      if (observation._tag === 'NonError') {
        runError = undefined;
        evidence = undefined;
        return;
      }
      runError = {
        provider: observation.provider,
        errorMessage: observation.errorMessage,
        resetsAt: observation.resetsAt,
      };
    },

    classify(now) {
      const currentEvidence = evidence;
      const currentRunError = runError;
      evidence = undefined;
      runError = undefined;

      if (!currentRunError) {
        return undefined;
      }
      if (isNonResumable(currentRunError.errorMessage)) {
        return undefined;
      }

      const family = providerFamily(currentRunError.provider);
      if (!family) {
        return undefined;
      }

      const fresh =
        currentEvidence &&
        currentEvidence.provider === currentRunError.provider &&
        now - currentEvidence.at < EVIDENCE_FRESHNESS_MS
          ? currentEvidence
          : undefined;

      const freshStatus = fresh ? 429 : undefined;

      const isLimit =
        family === 'codex'
          ? isCodexUsageLimit(currentRunError.errorMessage, freshStatus)
          : isAnthropicUsageLimit(currentRunError.errorMessage, freshStatus);

      if (!isLimit) {
        return undefined;
      }

      if (currentRunError.resetsAt !== undefined) {
        return { provider: family, resetAt: currentRunError.resetsAt, source: 'metadata' };
      }

      const headerReset =
        fresh &&
        (family === 'codex'
          ? parseCodexHeaders(fresh.headers, fresh.at)
          : parseAnthropicHeaders(fresh.headers, fresh.at));

      if (headerReset) {
        return { provider: family, resetAt: headerReset, source: 'header' };
      }

      if (family === 'codex') {
        const bodyReset = parseCodexErrorBody(currentRunError.errorMessage, now);
        if (bodyReset) {
          return { provider: family, resetAt: bodyReset, source: 'body' };
        }
      }

      return { provider: family, resetAt: undefined };
    },
  };
}

function isNonResumable(errorMessage: string): boolean {
  for (const pattern of NON_RESUMABLE_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return true;
    }
  }
  return false;
}
