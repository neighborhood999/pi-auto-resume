import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { loadAutoResumeConfig, saveAutoResumeConfig } from './config.ts';
import { ResumeCountdown } from './countdown.ts';
import { createUsageLimitDetector, providerFamily } from './providers/detect.ts';
import { fetchAnthropicReset } from './providers/anthropic.ts';
import { fetchCodexReset } from './providers/codex.ts';
import type { UsageLimitHit } from './providers/types.ts';
import { parsePendingResumeState, pendingResumeEntryData } from './pending.ts';
import { formatFooterStatus } from './render.ts';
import {
  DEFAULT_CONFIG,
  isAutoResumeEnabled,
  nextResumeScheduleState,
  type AutoResumeConfig,
  type ResumeScheduleEvent,
  type ResumeScheduleState,
  type SessionEnablement,
} from './schedule.ts';
import { createTerminalBell } from './terminal.ts';

const DEFAULT_RESUME_PROMPT =
  'The previous turn was interrupted by a provider usage limit and has been auto-resumed. Re-attempt the interrupted work and continue the task.';
const RESUME_NOTICE = '✓ usage limit lifted — resuming task';
const PENDING_ENTRY_TYPE = 'auto-resume/pending';
const RESOLVED_ENTRY_TYPE = 'auto-resume/resolved';
const STATUS_KEY = 'autoresume';
const USAGE_API_TIMEOUT_MS = 10_000;

/** Side effects that are injectable at the composition-root boundary. */
export type AutoResumeDependencies = {
  /** Ring once when the resumed run first succeeds. */
  readonly terminalBell?: () => void;
  /** Sample in [0, 1) for wake jitter. */
  readonly random?: () => number;
  /** Report a low-noise, sanitized diagnostic for a failed usage lookup. */
  readonly diagnostic?: (message: string) => void;
};

type TargetModel = {
  readonly provider: string;
  readonly modelId: string;
  readonly displayName: string;
};

type ClassificationGuard = {
  readonly lifecycleGeneration: number;
  readonly runGeneration: number;
  readonly modelSelectionGeneration: number;
  readonly enablementGeneration: number;
  readonly target: TargetModel;
};

type SessionStartGuard = {
  readonly lifecycleGeneration: number;
  readonly modelSelectionGeneration: number;
  readonly enablementGeneration: number;
};

/**
 * Composition root: detect provider usage-limit failures, wait for the reset
 * window, and resume the interrupted task automatically.
 *
 * @param pi - Pi's extension API.
 * @param dependencies - Optional testable shell effects.
 */
export default function autoResume(
  pi: ExtensionAPI,
  dependencies: AutoResumeDependencies = {},
): void {
  const detector = createUsageLimitDetector();
  const terminalBell = dependencies.terminalBell ?? createTerminalBell();
  const diagnostic = dependencies.diagnostic ?? ((message: string) => console.warn(message));
  const random = dependencies.random ?? Math.random;
  let schedule: ResumeScheduleState = { phase: 'idle' };
  let config: AutoResumeConfig = DEFAULT_CONFIG;
  let sessionOverride: SessionEnablement = 'Inherit';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let countdown: ResumeCountdown | undefined;
  let overlayDone: ((result: void) => void) | undefined;
  let modelLabel = '';
  let targetModel: TargetModel | undefined;
  let lifecycleGeneration = 0;
  let runGeneration = 0;
  let modelSelectionGeneration = 0;
  let enablementGeneration = 0;
  let sessionAbort: AbortController | undefined;
  let queuedResumePrompt: string | undefined;
  let resumePromptPreflight = false;
  let resumedRunStarted = false;

  function clearResumeConfirmation(): void {
    queuedResumePrompt = undefined;
    resumePromptPreflight = false;
    resumedRunStarted = false;
  }

  function enabled(): boolean {
    return isAutoResumeEnabled(config, sessionOverride);
  }

  function dispatch(event: ResumeScheduleEvent, ctx: ExtensionContext): void {
    const previous = schedule;
    schedule = nextResumeScheduleState(previous, event, Date.now(), config);
    if (previous.phase === 'resuming' && schedule.phase !== 'resuming') {
      clearResumeConfirmation();
    }

    if (schedule.phase === 'idle') {
      clearTargetModel();
      if (previous.phase !== 'idle') {
        tearDown(ctx);
        pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      }
      return;
    }

    if (schedule.phase === 'waiting' && previous.phase !== 'waiting') {
      if (!enabled()) {
        schedule = { phase: 'idle' };
        clearTargetModel();
        tearDown(ctx);
        return;
      }
      refreshModelLabel(ctx);
      armTimer(ctx);
      showCountdown(ctx);
      appendPendingEntry();
    } else if (schedule.phase === 'waiting' && previous.phase === 'waiting') {
      refreshModelLabel(ctx);
      armTimer(ctx);
      updateCountdown(ctx);
      // A waiting→waiting update is the durable checkpoint. This is what
      // preserves the latest hit and attempt after a restart.
      appendPendingEntry();
    }

    if (schedule.phase === 'resuming' && previous.phase !== 'resuming') {
      refreshModelLabel(ctx);
      updateCountdown(ctx);
      sendResume(ctx);
    }
  }

  function armTimer(ctx: ExtensionContext): void {
    clearTimer();
    if (schedule.phase !== 'waiting') {
      return;
    }
    const delay = Math.max(0, schedule.wakeAt - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      if (!enabled() || !targetMatches(ctx)) {
        cancelWithNotice(
          ctx,
          'Auto-resume cancelled because the current model changed or is disabled.',
        );
        return;
      }
      dispatch({ type: 'wake' }, ctx);
    }, delay);
    timer.unref?.();
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function showCountdown(ctx: ExtensionContext): void {
    if (ctx.mode !== 'tui') {
      ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(schedule));
      return;
    }

    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        overlayDone = done;
        const instance = new ResumeCountdown(tui, theme);
        countdown = instance;
        instance.update(schedule, modelLabel);
        return instance;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: 'top-right',
          width: 46,
          offsetY: 1,
          nonCapturing: true,
          visible: (termWidth) => termWidth >= 70,
        },
      },
    );

    ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(schedule));
  }

  function updateCountdown(ctx: ExtensionContext): void {
    countdown?.update(schedule, modelLabel);
    ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(schedule));
  }

  function tearDown(ctx: ExtensionContext): void {
    clearTimer();
    if (overlayDone) {
      overlayDone();
      overlayDone = undefined;
    }
    countdown = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  function appendPendingEntry(): void {
    if (schedule.phase !== 'waiting' || !targetModel) {
      return;
    }
    const family = providerFamily(targetModel.provider);
    if (family !== schedule.hit.provider) {
      return;
    }
    pi.appendEntry(
      PENDING_ENTRY_TYPE,
      pendingResumeEntryData({
        schemaVersion: 1,
        provider: targetModel.provider,
        modelId: targetModel.modelId,
        model: targetModel.displayName,
        family,
        hit: schedule.hit,
        wakeAt: schedule.wakeAt,
        attempt: schedule.attempt,
      }),
    );
  }

  function clearTargetModel(): void {
    targetModel = undefined;
  }

  function targetMatches(ctx: ExtensionContext, target = targetModel): boolean {
    return (
      target !== undefined &&
      ctx.model !== undefined &&
      ctx.model.provider === target.provider &&
      ctx.model.id === target.modelId
    );
  }

  function cancelWithNotice(ctx: ExtensionContext, message: string): void {
    if (schedule.phase !== 'idle') {
      dispatch({ type: 'cancel' }, ctx);
    } else {
      clearTargetModel();
    }
    ctx.ui.notify(message, 'warning');
  }

  function sendResume(ctx: ExtensionContext): void {
    if (!enabled() || !targetMatches(ctx)) {
      cancelWithNotice(
        ctx,
        'Auto-resume cancelled because the current model changed or is disabled.',
      );
      return;
    }
    // An in-flight user turn owns its outcome: settlement will disarm a
    // successful wait or re-arm a limit hit. Do not submit while Pi is busy.
    if (!ctx.isIdle()) {
      return;
    }
    const prompt = config.resumePrompt ?? DEFAULT_RESUME_PROMPT;
    queuedResumePrompt = prompt;
    try {
      pi.sendUserMessage(prompt);
    } catch (cause: unknown) {
      // Queueing is a synchronous shell operation. Cancellation is safer than
      // leaving the reducer in `resuming` with no future settlement event.
      dispatch({ type: 'cancel' }, ctx);
      ctx.ui.notify(
        'Auto-resume cancelled because the resume message could not be queued.',
        'error',
      );
      diagnostic(
        `pi-auto-resume: resume message could not be queued (${sanitizeDiagnostic(cause)}).`,
      );
    }
  }

  function refreshModelLabel(ctx: ExtensionContext): void {
    const model = ctx.model;
    if (model && (!targetModel || targetMatches(ctx, targetModel))) {
      modelLabel = formatModelLabel(model.provider, model.name, ctx.thinkingLevel);
      return;
    }
    if (targetModel) {
      modelLabel = formatModelLabel(
        targetModel.provider,
        targetModel.displayName,
        ctx.thinkingLevel,
      );
    }
  }

  function formatModelLabel(
    provider: string,
    name: string,
    thinkingLevel: string | undefined,
  ): string {
    const base = `${provider} · ${name}`;
    return thinkingLevel ? `${base} (${thinkingLevel})` : base;
  }

  pi.on('model_select', (event, ctx) => {
    modelSelectionGeneration += 1;
    modelLabel = formatModelLabel(event.model.provider, event.model.name, ctx.thinkingLevel);
    if (
      targetModel &&
      (targetModel.provider !== event.model.provider || targetModel.modelId !== event.model.id)
    ) {
      if (schedule.phase === 'waiting' || schedule.phase === 'resuming') {
        cancelWithNotice(ctx, 'Auto-resume cancelled because the model changed.');
      } else {
        // A usage-API lookup may still be resolving after classification. Do
        // not retain its failed model as a target once the schedule is idle.
        clearTargetModel();
      }
    }
  });

  pi.on('thinking_level_select', (event, ctx) => {
    const model = ctx.model;
    if (model) {
      modelLabel = formatModelLabel(model.provider, model.name, event.level);
    }
  });

  pi.on('before_agent_start', (event) => {
    if (schedule.phase === 'resuming' && event.prompt === queuedResumePrompt) {
      resumePromptPreflight = true;
    }
  });

  // Pi emits agent_start for both agentLoop and agentLoopContinue; automatic
  // retries therefore get a fresh detector attempt boundary.
  pi.on('agent_start', () => {
    runGeneration += 1;
    detector.onRunStart();
  });

  pi.on('after_provider_response', (event, ctx) => {
    if (!enabled()) {
      return;
    }
    const provider = ctx.model?.provider ?? 'unknown';
    detector.onProviderResponse(provider, event.status, event.headers, Date.now());
  });

  pi.on('agent_end', (event, ctx) => {
    let lastAssistant: (typeof event.messages)[number] | undefined;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const candidate = event.messages[index];
      if (candidate?.role === 'assistant') {
        lastAssistant = candidate;
        break;
      }
    }
    if (!lastAssistant) {
      detector.onRunEnd({ _tag: 'NonError' });
      return;
    }
    // SAFETY: Pi 0.84.4's AssistantMessage includes provider, model,
    // stopReason, and errorMessage. Keep the runtime record projection here so
    // this boundary remains compatible with the extension event typing.
    const message = lastAssistant as unknown as Record<string, unknown>;
    if (message['stopReason'] !== 'error' || typeof message['errorMessage'] !== 'string') {
      detector.onRunEnd({ _tag: 'NonError' });
      return;
    }
    const provider = typeof message['provider'] === 'string' ? message['provider'] : undefined;
    const modelId = typeof message['model'] === 'string' ? message['model'] : undefined;
    targetModel = makeTargetModel(provider, modelId, ctx);
    refreshModelLabel(ctx);
    detector.onRunEnd({
      _tag: 'Error',
      provider: provider ?? 'unknown',
      errorMessage: message['errorMessage'],
      resetsAt: extractResetsAt(message),
    });
  });

  pi.on('message_end', (event, ctx) => {
    if (schedule.phase !== 'resuming') {
      return;
    }
    const message = event.message;
    if (
      resumePromptPreflight &&
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.length === 1 &&
      message.content[0]?.type === 'text' &&
      message.content[0].text === queuedResumePrompt
    ) {
      // Pi emits the user message only after the run has actually started.
      // Later automatic retries belong to this same resume attempt.
      resumedRunStarted = true;
      queuedResumePrompt = undefined;
      resumePromptPreflight = false;
      return;
    }
    if (!resumedRunStarted || !isSuccessfulAssistant(message, targetModel)) {
      return;
    }
    dispatch({ type: 'confirmed' }, ctx);
    terminalBell();
    ctx.ui.notify(RESUME_NOTICE, 'info');
  });

  pi.on('agent_settled', async (_event, ctx) => {
    const hit = detector.classify(Date.now());
    if (!enabled()) {
      if (schedule.phase === 'idle') {
        clearTargetModel();
      }
      return;
    }
    if (hit) {
      const target = targetModel;
      if (!target || !targetMatches(ctx, target)) {
        if (schedule.phase !== 'idle') {
          cancelWithNotice(
            ctx,
            'Auto-resume cancelled because the failed model is no longer selected.',
          );
        }
        return;
      }

      const guard: ClassificationGuard = {
        lifecycleGeneration,
        runGeneration,
        modelSelectionGeneration,
        enablementGeneration,
        target,
      };
      const resolved = hit.resetAt !== undefined ? hit : await resolveResetViaApi(hit, ctx, guard);
      if (!resolved || !classificationIsCurrent(guard, ctx)) {
        if (schedule.phase === 'idle' && targetModel === guard.target) {
          clearTargetModel();
        }
        return;
      }
      dispatch({ type: 'limit', hit: resolved, jitter: random() }, ctx);
      if (schedule.phase === 'idle') {
        ctx.ui.notify('Auto-resume: max attempts reached, giving up.', 'warning');
      }
    } else if (schedule.phase !== 'idle') {
      dispatch({ type: 'settled-ok' }, ctx);
    } else {
      clearTargetModel();
    }
  });

  function classificationIsCurrent(guard: ClassificationGuard, ctx: ExtensionContext): boolean {
    return (
      lifecycleGeneration === guard.lifecycleGeneration &&
      runGeneration === guard.runGeneration &&
      modelSelectionGeneration === guard.modelSelectionGeneration &&
      enablementGeneration === guard.enablementGeneration &&
      targetModel === guard.target &&
      targetMatches(ctx, guard.target)
    );
  }

  async function resolveResetViaApi(
    hit: UsageLimitHit,
    ctx: ExtensionContext,
    guard: ClassificationGuard,
  ): Promise<UsageLimitHit | undefined> {
    if (!classificationIsCurrent(guard, ctx)) {
      return undefined;
    }
    const family = providerFamily(guard.target.provider);
    if (!family || family !== hit.provider) {
      return undefined;
    }

    try {
      const token = await ctx.modelRegistry.getApiKeyForProvider(guard.target.provider);
      if (!classificationIsCurrent(guard, ctx)) {
        return undefined;
      }
      if (!token) {
        diagnostic(`pi-auto-resume: usage API fallback unavailable (${family}; no credential).`);
        return hit;
      }

      const timeout = AbortSignal.timeout(USAGE_API_TIMEOUT_MS);
      const signal = sessionAbort ? AbortSignal.any([sessionAbort.signal, timeout]) : timeout;

      const result =
        family === 'codex'
          ? await fetchCodexReset({ token, signal, now: Date.now() })
          : await fetchAnthropicReset({ token, signal, now: Date.now() });

      if (!classificationIsCurrent(guard, ctx)) {
        return undefined;
      }
      if (result.ok) {
        return { provider: family, resetAt: result.reset.at, source: result.reset.source };
      }
      diagnostic(
        `pi-auto-resume: usage API fallback unavailable (${family}; ${sanitizeDiagnostic(result.error)}).`,
      );
    } catch (cause: unknown) {
      if (!classificationIsCurrent(guard, ctx)) {
        return undefined;
      }
      diagnostic(
        `pi-auto-resume: usage API fallback unavailable (${family}; ${sanitizeDiagnostic(cause)}).`,
      );
    }
    return hit;
  }

  pi.on('session_shutdown', (_event, ctx) => {
    tearDown(ctx);
    schedule = { phase: 'idle' };
    clearTargetModel();
    clearResumeConfirmation();
    lifecycleGeneration += 1;
    enablementGeneration += 1;
    sessionAbort?.abort();
    sessionAbort = undefined;
  });

  pi.on('session_start', async (event, ctx) => {
    // A new session/reload owns a fresh lifecycle. Never let a previous
    // session's config or confirmation continuation mutate this one.
    tearDown(ctx);
    schedule = { phase: 'idle' };
    clearTargetModel();
    clearResumeConfirmation();
    lifecycleGeneration += 1;
    modelSelectionGeneration += 1;
    enablementGeneration += 1;
    sessionAbort?.abort();
    sessionAbort = new AbortController();
    sessionOverride = 'Inherit';

    const loadGuard: SessionStartGuard = {
      lifecycleGeneration,
      modelSelectionGeneration,
      enablementGeneration,
    };
    const result = await loadAutoResumeConfig();
    if (!sessionStartIsCurrent(loadGuard)) {
      return;
    }
    if (result.ok) {
      config = result.config;
    } else {
      config = DEFAULT_CONFIG;
      ctx.ui.notify(`${result.error} Using default auto-resume configuration.`, 'warning');
    }

    if (event.reason !== 'startup' && event.reason !== 'resume') {
      return;
    }

    // SAFETY: SessionEntry is a union; this boundary projection lets the
    // persisted-data parser handle the custom entry shape without widening the
    // functional core to framework types.
    const entries = ctx.sessionManager.getEntries() as unknown as readonly Record<
      string,
      unknown
    >[];
    const pendingEntry = findLastPendingEntry(entries);
    if (!pendingEntry) {
      return;
    }
    const pendingData = pendingEntry['data'];
    const parsed = parsePendingResumeState(pendingData);
    if (!parsed.ok) {
      pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      ctx.ui.notify(`${parsed.error} Pending auto-resume was discarded.`, 'warning');
      return;
    }
    const pending = parsed.state;
    const family = providerFamily(pending.provider);
    const pendingTarget: TargetModel = {
      provider: pending.provider,
      modelId: pending.modelId,
      displayName: pending.model,
    };

    if (family !== pending.family || !targetMatches(ctx, pendingTarget)) {
      pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      ctx.ui.notify(
        'Pending auto-resume was not re-armed because the current model differs.',
        'warning',
      );
      return;
    }
    if (!enabled()) {
      pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      return;
    }
    if (pending.attempt > config.maxAttempts) {
      pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      ctx.ui.notify('Auto-resume: persisted attempt limit reached; giving up.', 'warning');
      return;
    }
    if (!ctx.hasUI) {
      // Headless restart cannot ask for consent. Leave the pending entry in
      // place; a later UI session may offer the same re-arm.
      return;
    }

    const rearmGuard: ClassificationGuard = {
      lifecycleGeneration,
      runGeneration,
      modelSelectionGeneration,
      enablementGeneration,
      target: pendingTarget,
    };
    const confirmed = await ctx.ui.confirm(
      'Auto-resume',
      'A usage-limit wait was interrupted. Re-arm auto-resume?',
    );
    // The confirm continuation must re-check every identity that can change
    // while the dialog is open, including enablement and exact model ID.
    if (!rearmIsCurrent(rearmGuard, ctx) || !enabled()) {
      return;
    }
    if (!confirmed) {
      pi.appendEntry(RESOLVED_ENTRY_TYPE, {});
      return;
    }
    targetModel = pendingTarget;
    refreshModelLabel(ctx);
    dispatch(
      {
        type: 'restore',
        hit: pending.hit,
        wakeAt: pending.wakeAt,
        attempt: pending.attempt,
      },
      ctx,
    );
  });

  function rearmIsCurrent(guard: ClassificationGuard, ctx: ExtensionContext): boolean {
    return (
      lifecycleGeneration === guard.lifecycleGeneration &&
      runGeneration === guard.runGeneration &&
      modelSelectionGeneration === guard.modelSelectionGeneration &&
      enablementGeneration === guard.enablementGeneration &&
      (targetModel === undefined || targetModel === guard.target) &&
      targetMatches(ctx, guard.target)
    );
  }

  function sessionStartIsCurrent(guard: SessionStartGuard): boolean {
    return (
      lifecycleGeneration === guard.lifecycleGeneration &&
      modelSelectionGeneration === guard.modelSelectionGeneration &&
      enablementGeneration === guard.enablementGeneration
    );
  }

  pi.registerCommand('autoresume', {
    description: 'Auto-resume: on | off [--global] | now | cancel | status',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim().toLowerCase();

      if (arg === 'on') {
        enablementGeneration += 1;
        sessionOverride = 'Enabled';
        ctx.ui.notify('Auto-resume enabled for this session.', 'info');
        return;
      }

      if (arg === 'off' || arg === 'off --global') {
        enablementGeneration += 1;
        sessionOverride = 'Disabled';
        if (schedule.phase !== 'idle') {
          dispatch({ type: 'cancel' }, ctx);
        }
        if (arg === 'off --global') {
          const saved = await saveAutoResumeConfig({ ...config, enabled: false });
          config = { ...config, enabled: false };
          ctx.ui.notify(
            saved.ok
              ? 'Auto-resume disabled globally.'
              : `Auto-resume disabled for session. ${saved.error}`,
            saved.ok ? 'info' : 'warning',
          );
        } else {
          ctx.ui.notify('Auto-resume disabled for this session.', 'info');
        }
        return;
      }

      if (arg === 'now') {
        if (schedule.phase === 'waiting') {
          dispatch({ type: 'wake' }, ctx);
          return;
        }
        ctx.ui.notify('No auto-resume wait is active.', 'warning');
        return;
      }

      if (arg === 'cancel') {
        if (schedule.phase !== 'idle') {
          dispatch({ type: 'cancel' }, ctx);
          ctx.ui.notify('Auto-resume cancelled.', 'info');
          return;
        }
        ctx.ui.notify('No auto-resume is active.', 'warning');
        return;
      }

      if (arg === 'status' || arg === '') {
        const isEnabled = enabled();
        if (schedule.phase === 'idle') {
          ctx.ui.notify(`Auto-resume: ${isEnabled ? 'enabled' : 'disabled'}, idle.`, 'info');
        } else if (schedule.phase === 'waiting') {
          const until =
            schedule.hit.resetAt === undefined
              ? 'unknown'
              : `${new Date(schedule.wakeAt).toLocaleTimeString()}, reset via ${schedule.hit.source}`;
          ctx.ui.notify(
            `Auto-resume: waiting (attempt ${schedule.attempt}/${config.maxAttempts}, resumes ~${until}).`,
            'info',
          );
        } else {
          ctx.ui.notify(
            `Auto-resume: resuming (attempt ${schedule.attempt}/${config.maxAttempts}).`,
            'info',
          );
        }
        return;
      }

      ctx.ui.notify('Usage: /autoresume [on | off [--global] | now | cancel | status]', 'warning');
    },
  });
}

function isSuccessfulAssistant(message: unknown, target: TargetModel | undefined): boolean {
  const record = message as Record<string, unknown> | null | undefined;
  return (
    target !== undefined &&
    record?.['role'] === 'assistant' &&
    record['provider'] === target.provider &&
    record['model'] === target.modelId &&
    record['stopReason'] !== 'error' &&
    record['stopReason'] !== 'aborted'
  );
}

function makeTargetModel(
  provider: string | undefined,
  modelId: string | undefined,
  ctx: ExtensionContext,
): TargetModel | undefined {
  if (!provider || !modelId) {
    return undefined;
  }
  const displayName =
    ctx.model?.provider === provider && ctx.model.id === modelId ? ctx.model.name : modelId;
  return { provider, modelId, displayName };
}

/**
 * Try to extract a reset epoch (ms) from structured metadata on the message.
 *
 * @param message - Framework message projected to an unknown-keyed record.
 * @returns A finite positive epoch in milliseconds, if present.
 */
function extractResetsAt(message: Record<string, unknown>): number | undefined {
  const metadata = message['errorMetadata'];
  if (typeof metadata === 'object' && metadata !== null) {
    const meta = metadata as Record<string, unknown>;
    const direct = meta['resetsAt'];
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) {
      const milliseconds = direct > 1e12 ? direct : direct * 1000;
      if (Number.isFinite(milliseconds) && milliseconds > 0) {
        return milliseconds;
      }
    }
    const payload = meta['payload'];
    if (typeof payload === 'object' && payload !== null) {
      const epoch = (payload as Record<string, unknown>)['resets_at'];
      if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) {
        const milliseconds = epoch > 1e12 ? epoch : epoch * 1000;
        if (Number.isFinite(milliseconds) && milliseconds > 0) {
          return milliseconds;
        }
      }
    }
  }
  return undefined;
}

function findLastPendingEntry(
  entries: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const type = entry['customType'];
    if (type === RESOLVED_ENTRY_TYPE) {
      return undefined;
    }
    if (type === PENDING_ENTRY_TYPE) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Sanitize an expected provider-lookup failure for a one-line diagnostic.
 *
 * @param cause - An adapter error or unknown rejection value.
 * @returns A bounded, single-line message with common credentials redacted.
 */
export function sanitizeDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message
    .replace(/[\r\n]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(token|api[-_ ]?key)=\S+/gi, '$1=[redacted]')
    .slice(0, 160);
}
