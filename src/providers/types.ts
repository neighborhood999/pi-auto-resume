export type ProviderFamily = 'codex' | 'anthropic';

/** Origin of a known usage-limit reset; `unrecorded` denotes a legacy pending entry whose source was not saved. */
export type ResetSource = 'metadata' | 'header' | 'body' | 'usage-api' | 'unrecorded';

/** Which usage allowance ran out: the rolling five-hour one or the weekly one. */
export type UsageLimitWindow = 'five_hour' | 'weekly';

export type ResetInfo = {
  readonly at: number;
  readonly source: 'usage-api';
  readonly window?: UsageLimitWindow | undefined;
};

export type UsageResult =
  | { readonly ok: true; readonly reset: ResetInfo }
  | { readonly ok: false; readonly error: string };

export type UsageLimitHit =
  | {
      readonly provider: ProviderFamily;
      readonly resetAt: number;
      readonly source: ResetSource;
      readonly window?: UsageLimitWindow | undefined;
    }
  | {
      readonly provider: ProviderFamily;
      readonly resetAt: undefined;
    };
