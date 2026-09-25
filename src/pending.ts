import type { ProviderFamily, ResetSource, UsageLimitHit } from './providers/types.ts';

/** Version of the session custom-entry schema written by this extension. */
export const PENDING_SCHEMA_VERSION = 1 as const;

/**
 * Validated state persisted while a resume wait is active.
 *
 * The provider string and family are both retained: the former identifies the
 * exact model target and the latter identifies the reset API to use.
 */
export type PendingResumeState = {
  readonly schemaVersion: typeof PENDING_SCHEMA_VERSION;
  readonly provider: string;
  readonly modelId: string;
  readonly model: string;
  readonly family: ProviderFamily;
  readonly hit: UsageLimitHit;
  readonly wakeAt: number;
  readonly attempt: number;
};

/** Result of parsing a session custom entry. */
export type ParsePendingResumeStateResult =
  | { readonly ok: true; readonly state: PendingResumeState }
  | { readonly ok: false; readonly error: string };

/**
 * Parse the untrusted data from an `auto-resume/pending` session entry.
 *
 * Entries written before schema versioning are accepted as version one when
 * all of their fields satisfy the same constraints. New writes always include
 * `schemaVersion`, so future migrations can reject unknown representations.
 *
 * @param input - Unknown custom-entry data read from a session file.
 * @returns A refined pending state or a safe parse error.
 */
export function parsePendingResumeState(input: unknown): ParsePendingResumeStateResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'Pending auto-resume state is not an object.' };
  }

  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== undefined && schemaVersion !== PENDING_SCHEMA_VERSION) {
    return { ok: false, error: 'Pending auto-resume state has an unsupported schema version.' };
  }

  const provider = positiveString(input['provider']);
  const modelId = positiveString(input['modelId']);
  const model = positiveString(input['model']);
  const family = input['family'];
  const resetAt = positiveFiniteOptional(input['resetAt']);
  const source = resetSourceOptional(input['source']);
  const wakeAt = positiveFinite(input['wakeAt']);
  const attempt = positiveInteger(input['attempt']);

  if (!provider || !modelId || !model || !isProviderFamily(family)) {
    return { ok: false, error: 'Pending auto-resume state has an invalid model target.' };
  }
  if (
    resetAt === 'invalid' ||
    source === 'invalid' ||
    wakeAt === undefined ||
    attempt === undefined
  ) {
    return { ok: false, error: 'Pending auto-resume state has invalid timing or attempt data.' };
  }
  // Entries written before the reset source was recorded omit `source`.
  const hit: UsageLimitHit =
    resetAt === undefined
      ? { provider: family, resetAt: undefined }
      : { provider: family, resetAt, source: source ?? 'unrecorded' };

  return {
    ok: true,
    state: {
      schemaVersion: PENDING_SCHEMA_VERSION,
      provider,
      modelId,
      model,
      family,
      hit,
      wakeAt,
      attempt,
    },
  };
}

/** Convert validated pending state to the persisted custom-entry payload. */
export function pendingResumeEntryData(state: PendingResumeState): Record<string, unknown> {
  return {
    schemaVersion: state.schemaVersion,
    provider: state.provider,
    modelId: state.modelId,
    model: state.model,
    family: state.family,
    resetAt: state.hit.resetAt,
    source: state.hit.resetAt === undefined ? undefined : state.hit.source,
    wakeAt: state.wakeAt,
    attempt: state.attempt,
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function positiveString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function positiveFiniteOptional(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }
  return positiveFinite(value) ?? 'invalid';
}

function resetSourceOptional(value: unknown): ResetSource | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }
  return isResetSource(value) ? value : 'invalid';
}

function isResetSource(value: unknown): value is ResetSource {
  return (
    value === 'metadata' ||
    value === 'header' ||
    value === 'body' ||
    value === 'usage-api' ||
    value === 'unrecorded'
  );
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isProviderFamily(value: unknown): value is ProviderFamily {
  return value === 'codex' || value === 'anthropic';
}
