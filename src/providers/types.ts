export type ProviderFamily = 'codex' | 'anthropic';

export type ResetSource = 'metadata' | 'header' | 'body' | 'usage-api' | 'unrecorded';

export type ResetInfo = {
  readonly at: number;
  readonly source: 'usage-api';
  readonly window?: string | undefined;
};

export type UsageResult =
  | { readonly ok: true; readonly reset: ResetInfo }
  | { readonly ok: false; readonly error: string };

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
