import type { UsageLimitHit } from './providers/types.ts';

/** Tagged union of resume-schedule phases. */
export type ResumeScheduleState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'waiting';
      readonly hit: UsageLimitHit;
      readonly wakeAt: number;
      readonly attempt: number;
    }
  | {
      readonly phase: 'resuming';
      readonly hit: UsageLimitHit;
      readonly attempt: number;
    };

/** Events the composition root reports to the schedule reducer. */
export type ResumeScheduleEvent =
  | {
      readonly type: 'limit';
      readonly hit: UsageLimitHit;
      /** Sample in [0, 1). */
      readonly jitter: number;
    }
  | {
      readonly type: 'restore';
      readonly hit: UsageLimitHit;
      readonly wakeAt: number;
      readonly attempt: number;
    }
  | { readonly type: 'settled-ok' }
  | { readonly type: 'confirmed' }
  | { readonly type: 'wake' }
  | { readonly type: 'cancel' };

/** Session-local override for the persisted enablement setting. */
export type SessionEnablement = 'Inherit' | 'Enabled' | 'Disabled';

/** Resolve whether auto-resume is enabled for this session. */
export function isAutoResumeEnabled(
  config: Pick<AutoResumeConfig, 'enabled'>,
  override: SessionEnablement,
): boolean {
  return override === 'Enabled' || (override === 'Inherit' && config.enabled);
}

/** Persisted user preferences for auto-resume behavior. */
export type AutoResumeConfig = {
  readonly enabled: boolean;
  readonly bufferMs: number;
  readonly jitterMs: number;
  readonly pollIntervalMs: number;
  readonly maxAttempts: number;
  readonly resumePrompt?: string | undefined;
};

/** Defaults used when no user config exists. */
export const DEFAULT_CONFIG: AutoResumeConfig = {
  enabled: true,
  bufferMs: 45_000,
  jitterMs: 15_000,
  pollIntervalMs: 600_000,
  maxAttempts: 6,
};

/**
 * Pure reducer: compute the next schedule state from the current state and an event.
 *
 * The composition root reports what happened; this function decides which
 * transition applies. See spec §6.2 for the full rule set.
 */
export function nextResumeScheduleState(
  state: ResumeScheduleState,
  event: ResumeScheduleEvent,
  now: number,
  config: AutoResumeConfig,
): ResumeScheduleState {
  switch (event.type) {
    case 'limit': {
      if (state.phase === 'resuming') {
        const attempt = state.attempt + 1;
        if (attempt > config.maxAttempts) {
          return { phase: 'idle' };
        }
        return {
          phase: 'waiting',
          hit: event.hit,
          wakeAt: deriveWakeAt(event.hit, event.jitter, now, config),
          attempt,
        };
      }
      if (state.phase === 'waiting') {
        return {
          phase: 'waiting',
          hit: event.hit,
          wakeAt: deriveWakeAt(event.hit, event.jitter, now, config),
          attempt: state.attempt,
        };
      }
      return {
        phase: 'waiting',
        hit: event.hit,
        wakeAt: deriveWakeAt(event.hit, event.jitter, now, config),
        attempt: 1,
      };
    }
    case 'restore': {
      if (event.attempt > config.maxAttempts) {
        return { phase: 'idle' };
      }
      return {
        phase: 'waiting',
        hit: event.hit,
        wakeAt: event.wakeAt,
        attempt: event.attempt,
      };
    }
    case 'settled-ok': {
      return { phase: 'idle' };
    }
    case 'confirmed': {
      if (state.phase === 'resuming') {
        return { phase: 'idle' };
      }
      return state;
    }
    case 'wake': {
      if (state.phase === 'waiting') {
        return { phase: 'resuming', hit: state.hit, attempt: state.attempt };
      }
      return state;
    }
    case 'cancel': {
      return { phase: 'idle' };
    }
  }
}

function deriveWakeAt(
  hit: UsageLimitHit,
  jitter: number,
  now: number,
  config: AutoResumeConfig,
): number {
  if (hit.resetAt !== undefined) {
    return hit.resetAt + config.bufferMs + Math.floor(jitter * config.jitterMs);
  }
  return now + config.pollIntervalMs;
}
