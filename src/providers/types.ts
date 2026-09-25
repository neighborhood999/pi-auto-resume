export type ProviderFamily = 'codex' | 'anthropic';

/**
 * Where a known reset time came from. `unrecorded` marks pending entries
 * persisted before the source was recorded.
 */
export type ResetSource = 'metadata' | 'header' | 'body' | 'usage-api' | 'unrecorded';

export type ResetInfo = {
  readonly at: number;
  readonly source: 'usage-api';
  readonly window?: string | undefined;
};

export type UsageResult =
  | { readonly ok: true; readonly reset: ResetInfo }
  | { readonly ok: false; readonly error: string };

/** A classified usage-limit failure; a known reset always carries its source. */
export type UsageLimitHit =
  | {
      readonly provider: ProviderFamily;
      readonly resetAt: number;
      readonly source: ResetSource;
    }
  | {
      readonly provider: ProviderFamily;
      readonly resetAt: undefined;
    };
