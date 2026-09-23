export type ProviderFamily = 'codex' | 'anthropic';

export type ResetInfo = {
  readonly at: number;
  readonly source: 'header' | 'body' | 'usage-api';
  readonly window?: string | undefined;
};

export type UsageResult =
  | { readonly ok: true; readonly reset: ResetInfo }
  | { readonly ok: false; readonly error: string };

export type UsageLimitHit = {
  readonly provider: ProviderFamily;
  readonly resetAt: number | undefined;
};
