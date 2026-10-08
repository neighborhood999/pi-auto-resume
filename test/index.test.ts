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
  idle: boolean;
  readonly entries: TestEntry[];
  readonly hasUI: boolean;
  readonly mode: 'rpc' | 'tui';
  readonly overlays: Array<{
    readonly overlay?: boolean;
    readonly overlayOptions?: { readonly anchor?: string };
  }>;
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
      custom: (
        _factory: unknown,
        options?: {
          readonly overlay?: boolean;
          readonly overlayOptions?: { readonly anchor?: string };
        },
      ) => {
        if (options) {
          state.overlays.push(options);
        }
        return Promise.resolve(undefined);
      },
      select: async () => undefined,
      input: async () => undefined,
      onTerminalInput: () => () => undefined,
    },
    mode: state.mode,
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
    isIdle: () => state.idle,
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
    readonly mode?: 'rpc' | 'tui';
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
    idle: true,
    entries: options?.entries ? [...options.entries] : [],
    hasUI: options?.hasUI ?? true,
    mode: options?.mode ?? 'rpc',
    overlays: [],
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

function makeEmptyAssistantResponse(model: TestModel): Record<string, unknown> {
  return { ...assistantMessage(model, 'stop'), content: [], usage: { totalTokens: 0 } };
}

async function resumeNow(harness: ReturnType<typeof makeHarness>): Promise<void> {
  assert.ok(harness.api.command);
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);
  const prompt = harness.state.sentMessages.at(-1);
  assert.ok(prompt);
  await harness.api.emit('before_agent_start', { type: 'before_agent_start', prompt }, harness.ctx);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    harness.ctx,
  );
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

test('delayed empty retries preserve the reset classified at failure time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T06:00:00Z') });
  const cases = [
    {
      provider: 'claude-bridge',
      failedAt: '2026-10-08T07:09:59Z',
      settledAt: '2026-10-08T07:10:01Z',
      error:
        "Claude rate limit (five_hour) — resets 3:10:00 PM: You've hit your session limit · resets 3:10pm (Asia/Taipei)",
      headers: undefined,
      resetAt: '2026-10-08T07:10:00Z',
      wakeAt: '2026-10-08T07:10:45Z',
      source: 'body',
    },
    {
      provider: 'openai-codex',
      failedAt: '2026-10-08T06:00:00Z',
      settledAt: '2026-10-08T06:01:00Z',
      error: 'You have hit your ChatGPT usage limit. Try again in ~15 min.',
      headers: undefined,
      resetAt: '2026-10-08T06:15:00Z',
      wakeAt: '2026-10-08T06:15:45Z',
      source: 'body',
    },
    {
      provider: 'claude-bridge',
      failedAt: '2026-10-08T06:00:00Z',
      settledAt: '2026-10-08T06:11:00Z',
      error: 'internal server error',
      headers: { 'retry-after': '1200' },
      resetAt: '2026-10-08T06:20:00Z',
      wakeAt: '2026-10-08T06:20:45Z',
      source: 'header',
    },
  ];
  for (const item of cases) {
    t.mock.timers.setTime(Date.parse(item.failedAt));
    const model = { provider: item.provider, id: 'test-model', name: 'Test model' };
    const harness = makeHarness(model, { mode: 'tui' });
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      if (item.headers) {
        await harness.api.emit(
          'after_provider_response',
          {
            type: 'after_provider_response',
            status: 429,
            headers: item.headers,
          },
          harness.ctx,
        );
      }
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [assistantError(model, item.error)],
        },
        harness.ctx,
      );
      t.mock.timers.setTime(Date.parse(item.settledAt));
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [makeEmptyAssistantResponse(model)],
        },
        harness.ctx,
      );
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
      const pending = harness.api.appendedEntries.find(
        (entry) => entry.customType === 'auto-resume/pending',
      );
      assert.equal(pending?.data?.['resetAt'], Date.parse(item.resetAt), item.provider);
      assert.equal(pending?.data?.['wakeAt'], Date.parse(item.wakeAt), item.provider);
      assert.equal(pending?.data?.['source'], item.source, item.provider);
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

test('real tool output before an empty terminal response clears the preceding limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:49.151Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [assistantError(model, 'rate limit exceeded')],
    },
    harness.ctx,
  );
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  const toolOutput = {
    ...assistantMessage(model, 'toolUse'),
    content: [
      { type: 'toolCall', id: 'recovered-tool', name: 'read', arguments: { path: 'README.md' } },
    ],
    usage: { totalTokens: 1 },
  };
  await harness.api.emit('message_end', { type: 'message_end', message: toolOutput }, harness.ctx);
  const empty = makeEmptyAssistantResponse(model);
  await harness.api.emit('message_end', { type: 'message_end', message: empty }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [toolOutput, empty],
    },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  assert.equal(harness.state.overlays.length, 0);
  assert.equal(harness.api.appendedEntries.length, 0);
});

test('captured Claude bridge limit survives an empty zero-token retry at settlement', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:47.104Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });

  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [
        assistantError(
          model,
          "Claude rate limit (five_hour) — resets 3:10:00 PM: You've hit your session limit · resets 3:10pm (Asia/Taipei)",
        ),
      ],
    },
    harness.ctx,
  );
  t.mock.timers.setTime(Date.parse('2026-10-08T05:15:49.151Z'));
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  const emptyRetry = makeEmptyAssistantResponse(model);
  await harness.api.emit('message_end', { type: 'message_end', message: emptyRetry }, harness.ctx);
  await harness.api.emit('agent_end', { type: 'agent_end', messages: [emptyRetry] }, harness.ctx);
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  assert.equal(harness.state.overlays.length, 1);
  assert.equal(harness.state.overlays[0]?.overlayOptions?.anchor, 'top-right');
  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.equal(pending?.data?.['resetAt'], Date.parse('2026-10-08T07:10:00Z'));
  assert.equal(pending?.data?.['wakeAt'], Date.parse('2026-10-08T07:10:45Z'));
  assert.equal(pending?.data?.['provider'], model.provider);
  assert.equal(pending?.data?.['modelId'], model.id);
  assert.equal(pending?.data?.['source'], 'body');
});

test('multiple empty retries retain only the original failed attempt headers', async (t) => {
  const now = Date.parse('2026-10-08T05:15:47.104Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'after_provider_response',
    {
      type: 'after_provider_response',
      status: 429,
      headers: { 'retry-after': '60' },
    },
    harness.ctx,
  );
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [assistantError(model, 'internal server error')],
    },
    harness.ctx,
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
    await harness.api.emit(
      'after_provider_response',
      {
        type: 'after_provider_response',
        status: 429,
        headers: { 'retry-after': '3600' },
      },
      harness.ctx,
    );
    await harness.api.emit(
      'agent_end',
      {
        type: 'agent_end',
        messages: [makeEmptyAssistantResponse(model)],
      },
      harness.ctx,
    );
  }
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.equal(pending?.data?.['resetAt'], now + 60_000);
  assert.equal(pending?.data?.['source'], 'header');
  assert.equal(harness.state.overlays.length, 1);
});

test('empty retries cannot announce recovery during an auto-resumed limit run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:49.151Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });
  await armKnownLimit(harness);
  await resumeNow(harness);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [assistantError(model, 'rate limit exceeded')],
    },
    harness.ctx,
  );
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  const emptyRetry = makeEmptyAssistantResponse(model);
  await harness.api.emit('message_end', { type: 'message_end', message: emptyRetry }, harness.ctx);
  await harness.api.emit('agent_end', { type: 'agent_end', messages: [emptyRetry] }, harness.ctx);
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  assert.equal(harness.state.bells, 0);
  assert.equal(harness.state.notifications.includes('✓ usage limit lifted — resuming task'), false);
  assert.equal(resolvedCount(harness), 0);
  assert.equal(harness.api.appendedEntries.at(-1)?.data?.['attempt'], 2);
  assert.match(harness.state.statuses.get('autoresume') ?? '', /limit/);
});

test('only an empty zero-token retry from the failed target retains a limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:49.151Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const emptyRetry = makeEmptyAssistantResponse(model);
  const cases = [
    {
      name: 'real text',
      response: { ...emptyRetry, content: [{ type: 'text', text: 'Recovered' }] },
    },
    { name: 'tool use', response: { ...emptyRetry, stopReason: 'toolUse' } },
    { name: 'nonzero tokens', response: { ...emptyRetry, usage: { totalTokens: 1 } } },
    { name: 'missing usage', response: { ...assistantMessage(model, 'stop'), content: [] } },
    { name: 'aborted', response: { ...emptyRetry, stopReason: 'aborted' } },
    { name: 'newer ordinary error', response: assistantError(model, 'internal server error') },
    { name: 'different provider', response: { ...emptyRetry, provider: 'anthropic' } },
    { name: 'different model', response: { ...emptyRetry, model: 'claude-other' } },
  ];
  for (const item of cases) {
    const harness = makeHarness(model, { mode: 'tui' });
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [assistantError(model, 'rate limit exceeded')],
        },
        harness.ctx,
      );
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [item.response],
        },
        harness.ctx,
      );
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
      assert.equal(harness.state.overlays.length, 0, item.name);
      assert.equal(harness.api.appendedEntries.length, 0, item.name);
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

test('empty responses alone or after settlement never invent a limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:49.151Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });
  const empty = makeEmptyAssistantResponse(model);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit('agent_end', { type: 'agent_end', messages: [empty] }, harness.ctx);
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  assert.equal(harness.state.overlays.length, 0);

  await armKnownLimit(harness);
  assert.ok(harness.api.command);
  // SAFETY: cancel uses only the ExtensionContext fields supplied by makeContext.
  await harness.api.command('cancel', harness.ctx as unknown as ExtensionCommandContext);
  const checkpointCount = harness.api.appendedEntries.length;
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit('agent_end', { type: 'agent_end', messages: [empty] }, harness.ctx);
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  assert.equal(harness.api.appendedEntries.length, checkpointCount);
  assert.equal(harness.state.overlays.length, 1);
});

test('session and model changes discard a limit before an empty retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T05:15:49.151Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  for (const change of ['session', 'shutdown', 'model']) {
    const harness = makeHarness(model, { mode: 'tui' });
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [assistantError(model, 'rate limit exceeded')],
        },
        harness.ctx,
      );
      if (change === 'model') {
        const otherModel = { ...model, id: 'claude-other' };
        harness.state.model = otherModel;
        await harness.api.emit(
          'model_select',
          {
            type: 'model_select',
            model: otherModel,
            previousModel: model,
            source: 'set',
          },
          harness.ctx,
        );
        harness.state.model = model;
        await harness.api.emit(
          'model_select',
          {
            type: 'model_select',
            model,
            previousModel: otherModel,
            source: 'set',
          },
          harness.ctx,
        );
      } else if (change === 'shutdown') {
        await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
      } else {
        await harness.api.emit(
          'session_start',
          { type: 'session_start', reason: 'new' },
          harness.ctx,
        );
      }
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [makeEmptyAssistantResponse(model)],
        },
        harness.ctx,
      );
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
      assert.equal(harness.state.overlays.length, 0, change);
      assert.equal(harness.api.appendedEntries.length, 0, change);
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

test('captured Claude bridge failure arms a top-right reset countdown without metadata', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T16:00:29.411Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const harness = makeHarness(model, { mode: 'tui' });
  let credentialLookups = 0;
  harness.state.getApiKey = async () => {
    credentialLookups += 1;
    return undefined;
  };
  t.after(async () => {
    await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  });

  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'agent_end',
    {
      type: 'agent_end',
      messages: [
        assistantError(
          model,
          "Claude rate limit (five_hour) — resets 2:00:00 AM: You've hit your session limit · resets 2am (Asia/Taipei)",
        ),
      ],
    },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

  assert.equal(harness.state.overlays.length, 1);
  assert.equal(harness.state.overlays[0]?.overlay, true);
  assert.equal(harness.state.overlays[0]?.overlayOptions?.anchor, 'top-right');
  const pending = harness.api.appendedEntries.find(
    (entry) => entry.customType === 'auto-resume/pending',
  );
  assert.ok(pending?.data);
  assert.equal(pending.data['provider'], 'claude-bridge');
  assert.equal(pending.data['modelId'], 'claude-opus-5-5');
  assert.equal(pending.data['resetAt'], Date.parse('2026-10-02T18:00:00Z'));
  assert.equal(pending.data['wakeAt'], Date.parse('2026-10-02T18:00:45Z'));
  assert.equal(pending.data['source'], 'body');
  assert.equal(pending.data['window'], 'five_hour');
  assert.equal(credentialLookups, 0);

  await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
  for (const selectedModel of [
    model,
    { ...model, provider: 'anthropic' },
    { ...model, id: 'claude-other' },
  ]) {
    const restarted = makeHarness(selectedModel, { entries: [pending], mode: 'tui' });
    try {
      await restarted.api.emit(
        'session_start',
        { type: 'session_start', reason: 'startup' },
        restarted.ctx,
      );
      if (selectedModel === model) {
        const restored = restarted.api.appendedEntries.find(
          (entry) => entry.customType === 'auto-resume/pending',
        );
        assert.equal(restored?.data?.['provider'], 'claude-bridge');
        assert.equal(restored?.data?.['modelId'], 'claude-opus-5-5');
        assert.equal(restored?.data?.['wakeAt'], Date.parse('2026-10-02T18:00:45Z'));
        await resumeNow(restarted);
        assert.equal(restarted.state.sentMessages.length, 1);
        assert.deepEqual(restarted.state.model, model);
      } else {
        assert.equal(restarted.state.confirmCalls, 0);
        assert.equal(restarted.state.overlays.length, 0);
        assert.equal(restarted.state.sentMessages.length, 0);
        assert.equal(resolvedCount(restarted), 1);
      }
    } finally {
      await restarted.api.emit('session_shutdown', { type: 'session_shutdown' }, restarted.ctx);
    }
  }
});

test('unsupported Claude bridge resets stay unknown without an OAuth lookup', async (t) => {
  const now = Date.parse('2026-10-02T16:00:29.411Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  const cases = [
    { now, error: 'Claude rate limit (five_hour) — resets 2:00:00 AM: session limit' },
    { now, error: 'Claude rate limit (five_hour): session limit · resets 2am' },
    { now, error: 'Claude rate limit (seven_day): usage limit · resets 2am (Asia/Taipei)' },
    { now, error: 'Claude rate limit (five_hour): session limit · resets 13am (Asia/Taipei)' },
    { now, error: 'Claude rate limit (five_hour): session limit · resets 2:60am (Asia/Taipei)' },
    { now, error: 'Claude rate limit (five_hour): session limit · resets 2am (Invalid/Zone)' },
    { now, error: 'Claude rate limit (five_hour): session limit · resets 8am (Asia/Taipei)' },
    {
      now,
      error: 'Claude rate limit (five_hour): session limit · resets tomorrow 2am (Asia/Taipei)',
    },
    {
      now: Date.parse('2026-11-01T04:30:00Z'),
      error: 'Claude rate limit (five_hour): session limit · resets 1:30am (America/New_York)',
    },
    {
      now: Date.parse('2026-03-08T06:00:00Z'),
      error: 'Claude rate limit (five_hour): session limit · resets 2:30am (America/New_York)',
    },
  ];
  for (const item of cases) {
    t.mock.timers.setTime(item.now);
    const harness = makeHarness(model, { mode: 'tui' });
    let credentialLookups = 0;
    harness.state.getApiKey = async () => {
      credentialLookups += 1;
      return undefined;
    };
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        { type: 'agent_end', messages: [assistantError(model, item.error)] },
        harness.ctx,
      );
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);

      const pending = harness.api.appendedEntries.find(
        (entry) => entry.customType === 'auto-resume/pending',
      );
      assert.ok(pending?.data, item.error);
      assert.equal(pending.data['resetAt'], undefined, item.error);
      assert.equal(pending.data['source'], undefined);
      assert.equal(pending.data['wakeAt'], item.now + 600_000);
      assert.equal(pending.data['provider'], model.provider);
      assert.equal(pending.data['modelId'], model.id);
      assert.equal(credentialLookups, 0, item.error);
      assert.equal(harness.state.overlays.length, 1);
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

test('Claude bridge reset clocks handle meridiem, date rollover, offsets and DST without host timezone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-02T15:00:00Z') });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  for (const item of [
    { now: '2026-10-02T15:00:00Z', clock: '12am (Asia/Taipei)', reset: '2026-10-02T16:00:00Z' },
    { now: '2026-10-02T02:00:00Z', clock: '12pm (Asia/Taipei)', reset: '2026-10-02T04:00:00Z' },
    {
      now: '2026-10-02T18:00:00Z',
      clock: '1:15am (Asia/Kathmandu)',
      reset: '2026-10-02T19:30:00Z',
    },
    {
      now: '2026-03-08T06:00:00Z',
      clock: '3:30am (America/New_York)',
      reset: '2026-03-08T07:30:00Z',
    },
  ]) {
    t.mock.timers.setTime(Date.parse(item.now));
    const harness = makeHarness(model);
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'agent_end',
        {
          type: 'agent_end',
          messages: [
            assistantError(
              model,
              `Claude rate limit (five_hour) — resets 11:00:00 PM: session limit · resets ${item.clock}`,
            ),
          ],
        },
        harness.ctx,
      );
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
      const pending = harness.api.appendedEntries.find(
        (entry) => entry.customType === 'auto-resume/pending',
      );
      assert.equal(pending?.data?.['resetAt'], Date.parse(item.reset), item.clock);
      assert.equal(pending?.data?.['source'], 'body');
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

test('Claude bridge metadata and response headers retain priority over reset text', async (t) => {
  const now = Date.parse('2026-10-02T16:00:29.411Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const model = { provider: 'claude-bridge', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
  for (const metadata of [undefined, { resetsAt: (now + 120_000) / 1000 }]) {
    const harness = makeHarness(model);
    try {
      await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
      await harness.api.emit(
        'after_provider_response',
        { type: 'after_provider_response', status: 429, headers: { 'retry-after': '60' } },
        harness.ctx,
      );
      const message = assistantError(
        model,
        'Claude rate limit (five_hour): session limit · resets 2am (Asia/Taipei)',
      );
      if (metadata) {
        message['errorMetadata'] = metadata;
      }
      await harness.api.emit('agent_end', { type: 'agent_end', messages: [message] }, harness.ctx);
      await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
      const pending = harness.api.appendedEntries.find(
        (entry) => entry.customType === 'auto-resume/pending',
      );
      assert.equal(pending?.data?.['resetAt'], now + (metadata ? 120_000 : 60_000));
      assert.equal(pending?.data?.['source'], metadata ? 'metadata' : 'header');
    } finally {
      await harness.api.emit('session_shutdown', { type: 'session_shutdown' }, harness.ctx);
    }
  }
});

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

test('an assistant response before the resume prompt starts cannot confirm it', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
  const harness = makeHarness(model);
  await armKnownLimit(harness);
  await harness.api.command?.('now', harness.ctx as unknown as ExtensionCommandContext);
  assert.equal(harness.state.sentMessages.length, 1);

  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'stop') },
    harness.ctx,
  );
  assert.equal(resolvedCount(harness), 0);
  assert.equal(harness.state.bells, 0);

  const prompt = harness.state.sentMessages[0];
  assert.ok(prompt);
  await harness.api.emit('before_agent_start', { type: 'before_agent_start', prompt }, harness.ctx);
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
    harness.ctx,
  );
  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'stop') },
    harness.ctx,
  );
  assert.equal(resolvedCount(harness), 1);
  assert.equal(harness.state.bells, 1);
});

test('an in-flight user turn at timer wake cannot announce a resume', async () => {
  const model = { provider: 'anthropic', id: 'claude-one', name: 'Claude One' };
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
          wakeAt: Date.now() - 1,
          attempt: 1,
        },
      },
    ],
  });
  await harness.api.emit(
    'session_start',
    { type: 'session_start', reason: 'startup' },
    harness.ctx,
  );
  harness.state.idle = false;
  await harness.api.emit('agent_start', { type: 'agent_start' }, harness.ctx);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.state.statuses.get('autoresume'), '⏸ limit · checking…');
  assert.equal(harness.state.sentMessages.length, 0);
  await harness.api.emit(
    'message_end',
    { type: 'message_end', message: assistantMessage(model, 'stop') },
    harness.ctx,
  );
  assert.equal(resolvedCount(harness), 0);
  assert.equal(harness.state.bells, 0);
  assert.equal(harness.state.notifications.includes('✓ usage limit lifted — resuming task'), false);

  harness.state.idle = true;
  await harness.api.emit(
    'agent_end',
    { type: 'agent_end', messages: [assistantMessage(model, 'stop')] },
    harness.ctx,
  );
  await harness.api.emit('agent_settled', { type: 'agent_settled' }, harness.ctx);
  assert.equal(resolvedCount(harness), 1);
  assert.equal(harness.state.sentMessages.length, 0);
  assert.equal(harness.state.bells, 0);
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
