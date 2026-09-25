import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';

import autoResume, { sanitizeDiagnostic } from '../src/index.ts';

type TestModel = {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
};

type TestEntry = {
  readonly customType: string;
  readonly data?: Record<string, unknown>;
};

type ContextState = {
  model: TestModel | undefined;
  readonly entries: TestEntry[];
  readonly hasUI: boolean;
  readonly notifications: string[];
  readonly statuses: Map<string, string | undefined>;
  readonly sentMessages: string[];
  readonly customMessages: Array<{
    readonly customType: string;
    readonly content: string;
    readonly triggerTurn: boolean;
  }>;
  getApiKey: () => Promise<string | undefined>;
  confirm: () => Promise<boolean>;
  confirmCalls: number;
  bells: number;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

class FakeExtensionAPI {
  readonly handlers = new Map<string, EventHandler[]>();
  readonly appendedEntries: TestEntry[] = [];
  command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;

  on(event: string, handler: EventHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(
    _name: string,
    options: { readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
  ): void {
    this.command = options.handler;
  }

  appendEntry(customType: string, data?: Record<string, unknown>): void {
    this.appendedEntries.push(data === undefined ? { customType } : { customType, data });
  }

  sendUserMessage(content: string): void {
    this.contextState?.sentMessages.push(content);
  }

  sendMessage(
    message: { readonly customType: string; readonly content: string },
    options?: { readonly triggerTurn?: boolean },
  ): void {
    this.contextState?.customMessages.push({
      customType: message.customType,
      content: message.content,
      triggerTurn: options?.triggerTurn ?? true,
    });
  }

  contextState: ContextState | undefined;

  asExtensionAPI(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }

  async emit(event: string, value: unknown, ctx: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(value, ctx);
    }
  }
}

function makeContext(state: ContextState): ExtensionContext {
  const context = {
    ui: {
      confirm: async () => state.confirm(),
      notify: (message: string) => state.notifications.push(message),
      setStatus: (key: string, text: string | undefined) => state.statuses.set(key, text),
      custom: () => undefined,
      select: async () => undefined,
      input: async () => undefined,
      onTerminalInput: () => () => undefined,
    },
    mode: 'rpc',
    hasUI: state.hasUI,
    cwd: '/tmp/pi-auto-resume-test',
    sessionManager: {
      getEntries: () => state.entries,
    },
    modelRegistry: {
      getApiKeyForProvider: async () => state.getApiKey(),
    },
    get model() {
      return state.model;
    },
    scopedModels: [],
    thinkingLevel: 'off',
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => '',
  };
  return context as unknown as ExtensionContext;
}

function makeHarness(
  model: TestModel,
  options?: {
    readonly entries?: TestEntry[];
    readonly hasUI?: boolean;
    readonly random?: () => number;
  },
): {
  readonly api: FakeExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly state: ContextState;
} {
  const notifications: string[] = [];
  const state: ContextState = {
    model,
    entries: options?.entries ? [...options.entries] : [],
    hasUI: options?.hasUI ?? true,
    notifications,
    statuses: new Map(),
    sentMessages: [],
    customMessages: [],
    getApiKey: async () => undefined,
    confirm: async () => true,
    confirmCalls: 0,
    bells: 0,
  };
  const api = new FakeExtensionAPI();
  api.contextState = state;
  autoResume(api.asExtensionAPI(), {
    terminalBell: () => {
      state.bells += 1;
    },
    diagnostic: () => undefined,
    random: options?.random ?? (() => 0),
  });
  return { api, ctx: makeContext(state), state };
}

function assistantError(model: TestModel, errorMessage: string): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: model.provider,
    model: model.id,
    stopReason: 'error',
    errorMessage,
  };
}

function assistantMessage(model: TestModel, stopReason: string): Record<string, unknown> {
  return { role: 'assistant', provider: model.provider, model: model.id, stopReason };
}

async function resumeNow(harness: ReturnType<typeof makeHarness>): Promise<void> {
  assert.ok(harness.api.command);
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
}

function resolvedCount(harness: ReturnType<typeof makeHarness>): number {
  return harness.api.appendedEntries.filter((entry) => entry.customType === 'auto-resume/resolved')
    .length;
}

async function armKnownLimit(
  harness: ReturnType<typeof makeHarness>,
  errorMessage = 'rate limit exceeded',
): Promise<void> {
  const { api, ctx, state } = harness;
  const model = state.model;
  assert.ok(model);
  await api.emit('agent_start', { type: 'agent_start' }, ctx);
  await api.emit(
    'after_provider_response',
    { type: 'after_provider_response', status: 429, headers: { 'retry-after': '60' } },
    ctx,
  );
  await api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantError(model, errorMessage)] },
    ctx,
  );
  await api.emit('agent_settled', { type: 'agent_settled' }, ctx);
}

test('usage fallback diagnostics are one-line and credential-sanitized', () => {
  const message = sanitizeDiagnostic('Bearer secret-token token=abc api_key=def\\nsecond line');
  assert.equal(message.includes('secret-token'), false);
  assert.equal(message.includes('abc'), false);
  assert.equal(message.includes('def'), false);
  assert.equal(message.includes('\\n'), false);
  assert.ok(message.length <= 160);
});

test('usage API fallback failure preserves a classified hit with an unknown reset', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantError(model, 'rate limit exceeded')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.ok(pending);
  assert.equal(pending.data?.['resetAt'], undefined);
});

test('same-provider model ID selection cancels an active wait', async () => {
  const oldModel = { provider: 'anthropic', id: 'claude-old', name: 'Claude Old' };
  const harness = makeHarness(oldModel);
  await armKnownLimit(harness);

  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.ok(pending);
  assert.equal(pending.data?.['modelId'], oldModel.id);
  const newModel = { provider: 'anthropic', id: 'claude-new', name: 'Claude New' };
  harness.state.model = newModel;
  await harness.api.emit(
    'model_select',
    { type: 'model_select', model: newModel, previousModel: oldModel, source: 'set' },
    harness.ctx,
  );

  assert.equal(harness.state.sentMessages.length, 0);
  assert.ok(harness.state.notifications.some((message) => message.includes('model changed')));
  assert.ok(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/resolved'),
  );
});

test('model target is captured before usage API resolution and stale resolution cannot arm', async () => {
  const oldModel = { provider: 'anthropic', id: 'claude-old', name: 'Claude Old' };
  let resolveToken: ((token: string | undefined) => void) | undefined;
  const token = new Promise<string | undefined>((resolve) => {
    resolveToken = resolve;
  });
  const harness = makeHarness(oldModel);
  harness.state.getApiKey = async () => token;

  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [assistantError(oldModel, 'rate limit exceeded')],
    },
    harness.ctx,
  );
  const settled = harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  await Promise.resolve();

  const newModel = { provider: 'anthropic', id: 'claude-new', name: 'Claude New' };
  harness.state.model = newModel;
  await harness.api.emit(
    'model_select',
    { type: 'model_select', model: newModel, previousModel: oldModel, source: 'set' },
    harness.ctx,
  );
  assert.ok(resolveToken);
  resolveToken(undefined);
  await settled;

  assert.equal(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/pending'),
    false,
  );
  assert.equal(harness.state.sentMessages.length, 0);
});

test('first successful assistant message confirms the resume before settlement', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  await resumeNow(harness);
  assert.equal(harness.state.statuses.get('autoresume'), '⏸ limit · checking…');

  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'toolUse') },
    harness.ctx,
  );

  // The run is still going, but the HUD, pending entry, and signal are done.
  assert.equal(harness.state.statuses.get('autoresume'), undefined);
  assert.equal(resolvedCount(harness), 1);
  assert.equal(harness.state.bells, 1);
  assert.ok(harness.state.notifications.includes('✓ usage limit lifted — resuming task'));
  assert.deepEqual(harness.state.customMessages, []);

  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'stop') },
    harness.ctx,
  );
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantMessage(model, 'stop')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  assert.equal(harness.state.bells, 1);
  assert.equal(resolvedCount(harness), 1);
  assert.equal(harness.state.sentMessages.length, 1);
});

test('non-success messages during a resume do not confirm it', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  await resumeNow(harness);

  const other = { provider: 'anthropic', id: 'claude-other', name: 'Claude Other' };
  for (const message of [
    { role: 'user', content: 'resume' },
    assistantMessage(model, 'error'),
    assistantMessage(model, 'aborted'),
    assistantMessage(other, 'stop'),
  ]) {
    await harness.api.emit('message_end', { type: 'message_end', message }, harness.ctx);
  }

  assert.equal(harness.state.statuses.get('autoresume'), '⏸ limit · checking…');
  assert.equal(resolvedCount(harness), 0);
  assert.equal(harness.state.bells, 0);
});

test('a resumed run that settles without success disarms without announcing', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  await resumeNow(harness);

  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantMessage(model, 'aborted')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  assert.equal(harness.state.statuses.get('autoresume'), undefined);
  assert.equal(resolvedCount(harness), 1);
  assert.equal(harness.state.bells, 0);
  assert.equal(harness.state.notifications.includes('✓ usage limit lifted — resuming task'), false);
});

test('a limit later in a confirmed run re-arms as a fresh first attempt', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  await resumeNow(harness);
  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'toolUse') },
    harness.ctx,
  );

  await harness.api.emit(
    'after_provider_response',
    { type: 'after_provider_response', status: 429, headers: { 'retry-after': '60' } },
    harness.ctx,
  );
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantError(model, 'rate limit exceeded')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  const pending = harness.api.appendedEntries.filter(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.equal(pending.length, 2);
  assert.equal(pending.at(-1)?.data?.['attempt'], 1);
});

test('known resets are jittered and persist their source', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model, { random: () => 0.5 });
  await armKnownLimit(harness);

  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.ok(pending?.data);
  const { resetAt, wakeAt, source } = pending.data;
  assert.equal(typeof resetAt, 'number');
  assert.equal(typeof wakeAt, 'number');
  assert.equal(Number(wakeAt) - Number(resetAt), 45_000 + 7_500);
  assert.equal(source, 'header');
});

test('wake with an exact model mismatch sends nothing', async () => {
  const oldModel = { provider: 'anthropic', id: 'claude-old', name: 'Claude Old' };
  const harness = makeHarness(oldModel);
  await armKnownLimit(harness);
  assert.ok(harness.api.command);

  harness.state.model = { provider: 'anthropic', id: 'claude-new', name: 'Claude New' };
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);

  assert.equal(harness.state.sentMessages.length, 0);
  assert.ok(
    harness.state.notifications.some((message) => message.includes('current model changed')),
  );
});

test('restart mismatch resolves pending state without confirmation or re-arm', async () => {
  const currentModel = { provider: 'anthropic', id: 'claude-current', name: 'Claude Current' };
  const harness = makeHarness(currentModel, {
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          provider: 'anthropic',
          modelId: 'claude-previous',
          model: 'Claude Previous',
          family: 'anthropic',
          resetAt: Date.now() + 60_000,
          wakeAt: Date.now() + 60_000,
          attempt: 1,
        },
      },
    ],
  });
  harness.state.confirm = async () => {
    harness.state.confirmCalls += 1;
    return true;
  };

  await harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );

  assert.equal(harness.state.confirmCalls, 0);
  assert.equal(harness.state.sentMessages.length, 0);
  assert.ok(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/resolved'),
  );
  assert.ok(
    harness.state.notifications.some((message) => message.includes('current model differs')),
  );
});

test('waiting-to-waiting updates append the latest pending checkpoint', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);

  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'after_provider_response',
    { type: 'after_provider_response', status: 429, headers: { 'retry-after': '120' } },
    harness.ctx,
  );
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantError(model, 'rate limit exceeded')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  const pending = harness.api.appendedEntries.filter(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.equal(pending.length, 2);
  assert.equal(pending.at(-1)?.data?.['attempt'], 1);
  assert.equal(typeof pending.at(-1)?.data?.['wakeAt'], 'number');
});

test('restart restores attempt and wake state so maxAttempts survives', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const wakeAt = Date.now() + 60_000;
  const harness = makeHarness(model, {
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          schemaVersion: 1,
          provider: model.provider,
          modelId: model.id,
          model: model.name,
          family: 'anthropic',
          resetAt: wakeAt - 45_000,
          wakeAt,
          attempt: 6,
        },
      },
    ],
  });
  await harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  const restored = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.equal(restored?.data?.['attempt'], 6);
  assert.equal(restored?.data?.['wakeAt'], wakeAt);

  assert.ok(harness.api.command);
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'after_provider_response',
    { type: 'after_provider_response', status: 429, headers: { 'retry-after': '60' } },
    harness.ctx,
  );
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantError(model, 'rate limit exceeded')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  assert.ok(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/resolved'),
  );
});

test('model change while restart confirmation is pending cannot re-arm', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  let resolveConfirm: ((value: boolean) => void) | undefined;
  const harness = makeHarness(model, {
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          schemaVersion: 1,
          provider: model.provider,
          modelId: model.id,
          model: model.name,
          family: 'anthropic',
          wakeAt: Date.now() + 60_000,
          attempt: 2,
        },
      },
    ],
  });
  harness.state.confirm = () =>
    new Promise<boolean>((resolve) => {
      harness.state.confirmCalls += 1;
      resolveConfirm = resolve;
    });
  const start = harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  for (let attempt = 0; attempt < 100 && harness.state.confirmCalls === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(harness.state.confirmCalls, 1);

  const newModel = { provider: 'anthropic', id: 'claude-two', name: 'Claude Two' };
  harness.state.model = newModel;
  await harness.api.emit(
    'model_select',
    { type: 'model_select', model: newModel, previousModel: model, source: 'set' },
    harness.ctx,
  );
  resolveConfirm?.(true);
  await start;

  assert.equal(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/pending'),
    false,
  );
});

test('shutdown while restart confirmation is pending cannot mutate the next lifecycle', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  let resolveConfirm: ((value: boolean) => void) | undefined;
  const harness = makeHarness(model, {
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          schemaVersion: 1,
          provider: model.provider,
          modelId: model.id,
          model: model.name,
          family: 'anthropic',
          wakeAt: Date.now() + 60_000,
          attempt: 2,
        },
      },
    ],
  });
  harness.state.confirm = () =>
    new Promise<boolean>((resolve) => {
      harness.state.confirmCalls += 1;
      resolveConfirm = resolve;
    });
  const start = harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  resolveConfirm?.(true);
  await start;

  assert.equal(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/pending'),
    false,
  );
  assert.equal(harness.state.sentMessages.length, 0);
});

test('enablement change while confirmation is pending cannot re-arm', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  let resolveConfirm: ((value: boolean) => void) | undefined;
  const harness = makeHarness(model, {
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          schemaVersion: 1,
          provider: model.provider,
          modelId: model.id,
          model: model.name,
          family: 'anthropic',
          wakeAt: Date.now() + 60_000,
          attempt: 2,
        },
      },
    ],
  });
  harness.state.confirm = () =>
    new Promise<boolean>((resolve) => {
      harness.state.confirmCalls += 1;
      resolveConfirm = resolve;
    });
  const start = harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await harness.api.command?.('off', harness.ctx as unknown as ExtensionCommandContext);
  resolveConfirm?.(true);
  await start;

  assert.equal(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/pending'),
    false,
  );
});

test('headless restart preserves pending state without prompting or sending', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model, {
    hasUI: false,
    entries: [
      {
        customType: 'auto-resume/pending',
        data: {
          schemaVersion: 1,
          provider: model.provider,
          modelId: model.id,
          model: model.name,
          family: 'anthropic',
          wakeAt: Date.now() + 60_000,
          attempt: 2,
        },
      },
    ],
  });
  await harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  assert.equal(harness.state.confirmCalls, 0);
  assert.equal(harness.state.sentMessages.length, 0);
  assert.equal(harness.api.appendedEntries.length, 0);
});

test('synchronous resume enqueue failure cancels instead of staying resuming', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  harness.api.sendUserMessage = () => {
    throw new Error('queue unavailable');
  };
  assert.ok(harness.api.command);
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);

  assert.equal(harness.state.sentMessages.length, 0);
  assert.ok(harness.state.notifications.some((message) => message.includes('could not be queued')));
  assert.ok(
    harness.api.appendedEntries.some((entry) => entry.customType === 'auto-resume/resolved'),
  );
});
