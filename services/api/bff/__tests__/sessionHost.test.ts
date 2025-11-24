/// <reference types="vitest" />
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { getOrCreateTrace } from '@openai/agents-core';

import type {
  ISessionManager,
  SessionEventName,
  SessionLifecycleStatus,
  SessionManagerHooks,
  SessionConnectOptions,
} from '../../../realtime/types';
import type { RealtimeAgent } from '@openai/agents/realtime';
import {
  SessionHost,
  SessionHostError,
  type RealtimeEnvironmentSnapshot,
  type SessionStreamMessage,
} from '../sessionHost';
import type { VoiceControlDirective } from '@/shared/voiceControl';
import type { MemoryEntry, MemoryStore } from '../../../coreData/persistentMemory';
import type { HotwordCueService, HotwordCueRequest, HotwordCueResult } from '../hotwordCueService';

vi.mock('@openai/agents-core', () => ({
  getOrCreateTrace: vi.fn((fn: () => any, _options?: unknown) => fn()),
}));

vi.mock('../../../../framework/voice_gateway/LlmScenarioNameClassifier', () => ({
  LlmScenarioNameClassifier: class {
    classifyScenario = vi.fn(async (_input: string) => ({
      scenarioKey: 'demo',
      confidence: 1,
    }));
  },
}));

type HookedManager = ISessionManager<RealtimeAgent> & {
  hooks: SessionManagerHooks;
  connectMock: ReturnType<typeof vi.fn>;
  sendEventMock: ReturnType<typeof vi.fn>;
  lastConnectOptions: SessionConnectOptions<RealtimeAgent> | null;
  sentEvents: any[];
};

class FakeSessionManager extends EventEmitter implements HookedManager {
  public hooks: SessionManagerHooks = {};
  public status: SessionLifecycleStatus = 'DISCONNECTED';
  public connectMock = vi.fn();
  public sendEventMock = vi.fn();
  public lastConnectOptions: SessionConnectOptions<RealtimeAgent> | null = null;
  public sentEvents: any[] = [];

  constructor(private readonly hooksFactory: SessionManagerHooks) {
    super();
    this.updateHooks(hooksFactory);
  }

  getStatus(): SessionLifecycleStatus {
    return this.status;
  }

  updateHooks(next: SessionManagerHooks): void {
    this.hooks = next;
  }

  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'transport_event') {
      const payload = args.length > 1 ? args : args[0];
      this.hooks.onServerEvent?.('transport_event', payload);
    }
    return super.emit(event, ...args);
  }

  async connect(options?: SessionConnectOptions<RealtimeAgent>): Promise<void> {
    this.status = 'CONNECTED';
    this.hooks.onStatusChange?.('CONNECTED');
    this.connectMock(options);
    this.lastConnectOptions = options ?? null;
  }

  disconnect(): void {
    this.status = 'DISCONNECTED';
    this.hooks.onStatusChange?.('DISCONNECTED');
  }

  sendUserText(): void {}

  sendEvent(payload: Record<string, any>): void {
    this.sendEventMock(payload);
    this.sentEvents.push(payload);
    this.emit('transport_event', payload);
  }

  interrupt(): void {}
  mute(): void {}
  pushToTalkStart(): void {}
  pushToTalkStop(): void {}
}

class InMemoryMemoryStore implements MemoryStore {
  constructor(private data: Record<string, MemoryEntry[]> = {}) {}

  async read(key: string, limit?: number): Promise<MemoryEntry[]> {
    const list = this.data[key] ?? [];
    if (typeof limit === 'number' && limit > 0) {
      return list.slice(-limit);
    }
    return [...list];
  }

  async upsert(key: string, entry: MemoryEntry): Promise<void> {
    const list = this.data[key] ?? [];
    const idx = entry.itemId
      ? list.findIndex((item) => item.itemId === entry.itemId)
      : -1;
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...entry };
    } else {
      list.push(entry);
    }
    this.data[key] = list;
  }

  async reset(key: string): Promise<void> {
    delete this.data[key];
  }
}

class StubHotwordCueService implements HotwordCueService {
  public playCue = vi.fn(
    async (_request: HotwordCueRequest): Promise<HotwordCueResult> => ({
      cueId: 'cue_test',
      status: 'streamed',
      audio: 'BASE64_AUDIO',
    }),
  );
}

describe('SessionHost', () => {
  const scenarioMap: Record<string, RealtimeAgent[]> = {
    demo: [
      {
        name: 'demo-agent',
        instructions: 'demo',
      } as RealtimeAgent,
    ],
    kate: [
      {
        name: 'kate-agent',
        instructions: 'kate',
      } as RealtimeAgent,
    ],
    takuboku: [
      {
        name: 'takuboku-agent',
        instructions: 'haiku',
      } as RealtimeAgent,
    ],
    nutrition: [
      {
        name: 'nutrition-agent',
        instructions: 'nutrition',
      } as RealtimeAgent,
    ],
  };
  const originalContinuationWindowMs = process.env.HOTWORD_CONTINUATION_WINDOW_MS;

  let host: SessionHost;
  let managers: FakeSessionManager[];
  let envSnapshot: RealtimeEnvironmentSnapshot;
  let hotwordCueService: StubHotwordCueService;
  let responsesClient: { create: ReturnType<typeof vi.fn> };
  let intentClassifier: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.HOTWORD_CONTINUATION_WINDOW_MS = '20';
    managers = [];
    envSnapshot = {
      warnings: [],
      audio: { enabled: true },
    };
    hotwordCueService = new StubHotwordCueService();
    responsesClient = { create: vi.fn() };
    intentClassifier = vi.fn(async () => false);
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      now: () => Date.now(),
      envInspector: () => envSnapshot,
      hotwordCueService,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
      memoryStore: new InMemoryMemoryStore(),
    });
  });

  afterEach(() => {
    if (originalContinuationWindowMs === undefined) {
      delete process.env.HOTWORD_CONTINUATION_WINDOW_MS;
    } else {
      process.env.HOTWORD_CONTINUATION_WINDOW_MS = originalContinuationWindowMs;
    }
  });

  it('creates sessions and forwards commands', async () => {
    const result = await host.createSession({ agentSetKey: 'demo' });
    expect(result.sessionId).toMatch(/^sess_/);
    expect(result.streamUrl).toContain(result.sessionId);
    expect(result.allowedModalities).toEqual(['audio', 'text']);
    expect(result.textOutputEnabled).toBe(true);

    const manager = managers[0]!;
    const status = await host.handleCommand(result.sessionId, {
      kind: 'input_text',
      text: 'hello',
    });
    expect(status).toBe('CONNECTED');
    expect(manager.sendEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'conversation.item.create' }),
    );
  });

  it('omits response metadata when not provided', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    await host.handleCommand(sessionId, { kind: 'input_text', text: 'no metadata' });
    const responseEvent = managers[0]!.sentEvents.find((event) => event?.type === 'response.create');
    expect(responseEvent).toEqual({ type: 'response.create' });
  });

  it('drops response metadata when provided (Realtime API compatibility)', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const metadata = { source: 'unit-test' };
    await host.handleCommand(sessionId, { kind: 'input_text', text: 'with metadata', metadata });
    const responseEvent = managers[0]!.sentEvents.find((event) => event?.type === 'response.create');
    expect(responseEvent).toEqual({ type: 'response.create' });
  });

  it('relays deep reasoning output when Responses API returns text', async () => {
    intentClassifier.mockResolvedValueOnce(true);
    responsesClient.create.mockResolvedValueOnce({
      id: 'resp_success',
      model: 'gpt-5.1',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: '深考の最終回答です。',
            },
          ],
        },
      ],
    });

    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    await host.handleCommand(sessionId, { kind: 'input_text', text: '深く考えて教えて' });

    const manager = managers[0]!;
    expect(responsesClient.create).toHaveBeenCalled();
    const finalSystem = manager.sentEvents
      .filter((ev) => ev?.item?.role === 'system')
      .map((ev) => ev.item)
      .find((item) => (item?.content?.[0] as any)?.text?.includes('最終回答'));
    expect(finalSystem?.content?.[0]?.text).toContain('最終回答');
    const responseEventCount = manager.sentEvents.filter((ev) => ev?.type === 'response.create').length;
    expect(responseEventCount).toBeGreaterThan(0);
  });

  it('falls back to realtime when deep reasoning output is empty', async () => {
    intentClassifier.mockResolvedValueOnce(true);
    responsesClient.create.mockResolvedValueOnce({
      id: 'resp_empty',
      model: 'gpt-5.1',
      output: [
        {
          content: [],
        },
      ],
    });

    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    await host.handleCommand(sessionId, { kind: 'input_text', text: 'じっくり理由を教えて' });

    const manager = managers[0]!;
    const fallbackSystem = manager.sentEvents
      .filter((ev) => ev?.item?.role === 'system')
      .map((ev) => ev.item)
      .find((item) => (item?.content?.[0] as any)?.text?.includes('深考パイプラインで回答が得られなかった'));
    expect(fallbackSystem?.content?.[0]?.text).toContain('深考パイプラインで回答が得られなかった');
    expect(responsesClient.create).toHaveBeenCalled();
  });

  it('routes all nutrition text to deep reasoning without intent triggers', async () => {
    responsesClient.create.mockResolvedValueOnce({
      id: 'resp_nutrition',
      model: 'gpt-5.1',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: '深考栄養回答です。',
            },
          ],
        },
      ],
    });

    const { sessionId } = await host.createSession({ agentSetKey: 'nutrition' });
    await host.handleCommand(sessionId, { kind: 'input_text', text: '夕飯は何が良い？' });
    const manager = managers[0]!;

    await vi.waitFor(() => {
      expect(responsesClient.create).toHaveBeenCalled();
    });
    expect(intentClassifier).not.toHaveBeenCalled();

    const placeholderEvent = manager.sentEvents.find(
      (event) =>
        typeof event?.item?.content?.[0]?.text === 'string' &&
        event.item.content[0].text.includes('丁寧に考えています'),
    );
    expect(placeholderEvent).toBeTruthy();

    const finalSystem = manager.sentEvents
      .filter((ev) => ev?.item?.role === 'system')
      .map((ev) => ev.item)
      .find((item) => (item?.content?.[0] as any)?.text?.includes('最終回答'));
    expect(finalSystem?.content?.[0]?.text).toContain('最終回答');
  });

  it('allows disabling text output when requested by the client', async () => {
    const result = await host.createSession({
      agentSetKey: 'demo',
      clientCapabilities: { outputText: false },
    });

    expect(result.allowedModalities).toEqual(['audio']);
    expect(result.textOutputEnabled).toBe(false);
  });

  it('injects user text when a hotword transcription is completed', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_1',
      transcript: 'Hey demo, 在庫を確認して',
    });

    await vi.waitFor(() => {
      const deleteEvent = manager.sentEvents.find((event) => event?.type === 'conversation.item.delete');
      expect(deleteEvent).toMatchObject({ item_id: 'conv_item_1' });
      const textEvent = manager.sentEvents.find((event) => event?.type === 'conversation.item.create');
      expect(textEvent?.item?.content?.[0]?.text).toBe('在庫を確認して');
    }, { timeout: 500 });
  });

  it('requests a scenario switch when a different hotword is detected', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, { id: 'hotword_listener', send: (msg) => received.push(msg) });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_2',
      transcript: 'Hey kate, 今日の予定を教えて',
    });

    await vi.waitFor(() => {
      const directive = received.find((msg) => msg.event === 'voice_control')?.data as VoiceControlDirective | undefined;
      expect(directive).toEqual({
        action: 'switchScenario',
        scenarioKey: 'kate',
        initialCommand: '今日の予定を教えて',
      });
    }, { timeout: 500 });
    unsubscribe();
  });

  it('handles hotwords with punctuation when switching scenarios', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, { id: 'hotword_listener_punct', send: (msg) => received.push(msg) });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_3',
      transcript: 'Hey!タクボク 秋の一句を読んで',
    });

    await vi.waitFor(() => {
      const directive = received.find((msg) => msg.event === 'voice_control')?.data as VoiceControlDirective | undefined;
      expect(directive).toEqual({
        action: 'switchScenario',
        scenarioKey: 'takuboku',
        initialCommand: '秋の一句を読んで',
      });
    }, { timeout: 500 });
    unsubscribe();
  });

  it('emits hotword cue SSE events when a cue is streamed successfully', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'hotword_cue_stream',
      send: (msg) => received.push(msg),
    });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_4',
      transcript: 'Hey demo, 状態を教えて',
    });

    await vi.waitFor(() => {
      expect(hotwordCueService.playCue).toHaveBeenCalled();
      const cueEvent = received.find((msg) => msg.event === 'hotword_cue');
      expect(cueEvent?.data).toMatchObject({
        status: 'streamed',
        scenarioKey: 'demo',
        audio: 'BASE64_AUDIO',
      });
    }, { timeout: 500 });
    unsubscribe();
  });

  it('streams a hotword cue when the prefix is detected in a delta event', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'hotword_cue_delta',
      send: (msg) => received.push(msg),
    });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'conv_item_delta',
      delta: 'Hey demo,',
    });

    await vi.waitFor(() => {
      expect(hotwordCueService.playCue).toHaveBeenCalled();
      const cueEvent = received.find((msg) => msg.event === 'hotword_cue');
      expect(cueEvent?.data).toMatchObject({
        scenarioKey: 'demo',
        status: 'streamed',
      });
    }, { timeout: 500 });
    unsubscribe();
  });

  it('does not emit hotword cues when disabled by config', async () => {
    hotwordCueService.playCue.mockClear();
    const received: SessionStreamMessage[] = [];
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      now: () => Date.now(),
      envInspector: () => envSnapshot,
      hotwordCueService,
      hotwordCueEnabled: false,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'hotword_cue_disabled',
      send: (msg) => received.push(msg),
    });
    const manager = managers[managers.length - 1]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_disabled',
      transcript: 'Hey demo, 状態を教えて',
    });

    await vi.waitFor(
      () => {
        expect(hotwordCueService.playCue).not.toHaveBeenCalled();
        const cueEvent = received.find((msg) => msg.event === 'hotword_cue');
        expect(cueEvent).toBeUndefined();
      },
      { timeout: 200 },
    );

    unsubscribe();
  });

  it('broadcasts fallback status when the cue service reports failure', async () => {
    hotwordCueService.playCue.mockResolvedValueOnce({
      cueId: 'cue_fail',
      status: 'fallback',
      reason: 'missing audio',
    });
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'hotword_cue_fallback',
      send: (msg) => received.push(msg),
    });
    const manager = managers[0]!;

    manager.hooks.onServerEvent?.('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'conv_item_5',
      transcript: 'Hey demo, 明日の予定を教えて',
    });

    await vi.waitFor(() => {
      const cueEvent = received.find((msg) => msg.event === 'hotword_cue');
      expect(cueEvent?.data).toMatchObject({
        status: 'fallback',
        reason: 'missing audio',
      });
      expect(cueEvent?.data?.audio).toBeUndefined();
    }, { timeout: 500 });
    unsubscribe();
  });

  it('enforces rate limiting', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    await Promise.all(
      Array.from({ length: 10 }).map(() =>
        host.handleCommand(sessionId, { kind: 'event', event: { type: 'noop' } }),
      ),
    );

    await expect(
      host.handleCommand(sessionId, { kind: 'event', event: { type: 'overflow' } }),
    ).rejects.toThrow(SessionHostError);
  });

  it('rehydrates and persists persistent memory', async () => {
    const seededAt = new Date('2025-01-01T00:00:00.000Z').toISOString();
    const memoryStore = new InMemoryMemoryStore({
      demo: [{ role: 'user', text: '以前の会話', createdAt: seededAt, itemId: 'item-very-long-id-that-will-be-hashed-for-replay-1234567890' }],
    });
    managers = [];
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      now: () => Date.now(),
      envInspector: () => envSnapshot,
      memoryStore,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    await host.createSession({ agentSetKey: 'demo', memoryEnabled: true });
    const manager = managers[0]!;
    const replayEvent = manager.sentEvents.find(
      (ev) => ev?.type === 'conversation.item.create' && ev?.item?.role === 'user',
    );
    expect(replayEvent?.item?.id).toMatch(/^pm_[A-Za-z0-9]+$/);

    manager.emit('history_added', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '新しい発話' }],
      itemId: 'item-new',
    });

    const stored = await memoryStore.read('demo');
    expect(stored.some((entry) => entry.text === '新しい発話')).toBe(true);
    expect(stored.find((entry) => entry.text === '以前の会話')?.createdAt).toBe(seededAt);
  });

  it('rehydrates memory across scenarios when clientTag is shared', async () => {
    const memoryStore = new InMemoryMemoryStore({
      sharedTag: [{ role: 'user', text: '私の身長は150センチです。', createdAt: '2025-01-01T00:00:00.000Z' }],
    });
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      envInspector: () => envSnapshot,
      memoryStore,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    await host.createSession({ agentSetKey: 'demo', clientTag: 'sharedTag' });
    const firstManager = managers[0]!;
    expect(
      firstManager.sentEvents.some(
        (ev) => ev?.type === 'conversation.item.create' && ev?.item?.content?.[0]?.text?.includes('身長'),
      ),
    ).toBe(true);

    await host.createSession({ agentSetKey: 'kate', clientTag: 'sharedTag' });
    const secondManager = managers[1]!;
    expect(
      secondManager.sentEvents.some(
        (ev) => ev?.type === 'conversation.item.create' && ev?.item?.content?.[0]?.text?.includes('身長'),
      ),
    ).toBe(true);
  });

  it('rehydrates legacy agentSet:clientTag memories into clientTag key', async () => {
    const legacyKey = 'demo:glasses01';
    const resets: string[] = [];
    const memoryStore = new InMemoryMemoryStore({
      [legacyKey]: [{ role: 'user', text: 'legacy memo', createdAt: '2025-01-02T00:00:00.000Z' }],
    });
    memoryStore.reset = vi.fn(async (key: string) => {
      resets.push(key);
      delete (memoryStore as any).data[key];
    });
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      envInspector: () => envSnapshot,
      memoryStore,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    await host.createSession({ agentSetKey: 'demo', clientTag: 'glasses01' });
    const manager = managers[0]!;
    expect(
      manager.sentEvents.some(
        (ev) => ev?.type === 'conversation.item.create' && ev?.item?.content?.[0]?.text === 'legacy memo',
      ),
    ).toBe(true);
    expect(resets).toContain(legacyKey);
    const merged = await memoryStore.read('glasses01');
    expect(merged.some((entry) => entry.text === 'legacy memo')).toBe(true);
  });

  it('drops trailing user-only turns to avoid auto-response on reconnect', async () => {
    const memoryStore = new InMemoryMemoryStore({
      develop: [
        { role: 'user', text: '前回の質問', createdAt: '2025-01-01T00:00:00.000Z' },
        { role: 'user', text: 'まだ？', createdAt: '2025-01-01T00:01:00.000Z' },
      ],
    });
    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      envInspector: () => envSnapshot,
      memoryStore,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    await host.createSession({ agentSetKey: 'demo', clientTag: 'develop' });
    const manager = managers[0]!;
    const replayedTexts = manager.sentEvents
      .filter((ev) => ev?.type === 'conversation.item.create')
      .map((ev) => ev?.item?.content?.[0]?.text);

    expect(replayedTexts).toContain('前回の質問');
    expect(replayedTexts).toContain('まだ？');
  });

  it('registers and resolves viewer sessions by clientTag override', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const registered = host.registerViewerSession('glasses01', sessionId, 'kate');

    expect(registered.sessionId).toBe(sessionId);
    expect(registered.scenarioKey).toBe('kate');
    expect(registered.streamUrl).toContain(sessionId);

    const resolved = host.resolveViewerSession('glasses01');
    expect(resolved.sessionId).toBe(sessionId);
    expect(resolved.scenarioKey).toBe('kate');
  });

  it('rejects viewer registration when session does not exist', () => {
    expect(() => host.registerViewerSession('glasses02', 'missing_session', 'demo')).toThrow(SessionHostError);
  });

  it('skips broadcasting persistent-memory history events to clients', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'sub_pmem',
      send: (msg) => received.push(msg),
    });
    const manager = managers[0]!;

    manager.emit('history_added', {
      type: 'message',
      role: 'assistant',
      itemId: 'pm:1:2025-01-01T00:00:00Z',
      content: [{ type: 'output_text', text: '古いメモ' }],
    });

    expect(received.find((msg) => msg.event === 'history_added')).toBeUndefined();
    unsubscribe();
  });

  it('broadcasts SSE messages to subscribers', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const messages: any[] = [];
    const unsubscribe = host.subscribe(sessionId, {
      id: 'sub',
      send: (msg) => messages.push(msg),
    });

    await host.handleCommand(sessionId, { kind: 'event', event: { type: 'pong' } });
    expect(messages.some((m) => m.event === 'status')).toBe(true);
    expect(messages.some((m) => m.event === 'transport_event')).toBe(true);
    unsubscribe();
  });

  it('forwards transport events exactly once', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const received: SessionStreamMessage[] = [];
    const unsubscribe = host.subscribe(sessionId, {
      id: 'listener',
      send: (msg) => received.push(msg),
    });

    const countTransportEvents = () =>
      received.filter((msg) => msg.event === 'transport_event').length;
    const initialCount = countTransportEvents();

    managers[0]!.hooks.onServerEvent?.('transport_event', {
      type: 'response.output_audio.delta',
      delta: 'PCM',
    });

    expect(countTransportEvents()).toBe(initialCount + 1);
    unsubscribe();
  });

  it('converts base64 images to data URLs when forwarding', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const base64 = Buffer.from('hello').toString('base64');

    await host.handleCommand(sessionId, {
      kind: 'input_image',
      data: base64,
      mimeType: 'image/png',
      encoding: 'base64',
      text: 'photo',
    });

    const sent = managers[0]!.sendEventMock.mock.calls.find(
      (c) => c[0]?.type === 'conversation.item.create',
    )?.[0];

    expect(sent?.item?.content?.[1]?.image_url).toBe(`data:image/png;base64,${base64}`);
  });

  it('falls back to text-only output when audio capability is disabled', async () => {
    envSnapshot = {
      warnings: ['Audio disabled for test'],
      audio: {
        enabled: false,
        reason: 'Missing OPENAI_REALTIME_VOICE',
      },
    };

    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      envInspector: () => envSnapshot,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    const result = await host.createSession({
      agentSetKey: 'demo',
      clientCapabilities: { audio: true },
    });

    expect(result.allowedModalities).toEqual(['text']);
    expect(result.textOutputEnabled).toBe(true);
    expect(result.capabilityWarnings).toContain('Audio disabled for test');
  });

  it('rejects sessions when both audio and text outputs are disabled', async () => {
    await expect(
      host.createSession({
        agentSetKey: 'demo',
        clientCapabilities: { audio: false, outputText: false },
      }),
    ).rejects.toThrow(SessionHostError);
  });

  it('suppresses transcription transport events when text output is disabled', async () => {
    const { sessionId } = await host.createSession({
      agentSetKey: 'demo',
      clientCapabilities: { outputText: false },
    });
    const received: SessionStreamMessage[] = [];
    const unsubscribe = host.subscribe(sessionId, {
      id: 'listener',
      send: (msg) => received.push(msg),
    });

    const countTransportEvents = () =>
      received.filter((msg) => msg.event === 'transport_event').length;
    const initialCount = countTransportEvents();

    managers[0]!.emit('transport_event', {
      type: 'response.output_text.delta',
      delta: 'Hello from transcript',
    });

    expect(countTransportEvents()).toBe(initialCount);

    managers[0]!.emit('transport_event', {
      type: 'response.output_audio.delta',
      delta: 'PCM',
    });

    expect(countTransportEvents()).toBe(initialCount + 1);
    unsubscribe();
  });

  it('emits session_error events with sanitized payloads', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    host = new SessionHost({
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      logger,
      envInspector: () => ({ warnings: [], audio: { enabled: true } }),
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });

    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const received: SessionStreamMessage[] = [];
    const unsubscribe = host.subscribe(sessionId, {
      id: 'listener',
      send: (msg) => received.push(msg),
    });

    managers[0]!.emit('error', {
      error: { code: 'access_denied', message: 'Audio output disabled', type: 'invalid_permission' },
    });

    const sessionError = received.find((msg) => msg.event === 'session_error');
    expect(sessionError?.data).toMatchObject({
      code: 'access_denied',
      message: 'Audio output disabled',
      type: 'invalid_permission',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Realtime session error',
      expect.objectContaining({ sessionId, code: 'access_denied' }),
    );

    unsubscribe();
  });

  it('emits voice_control events when the realtime agent requests a scenario switch', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'voice_listener',
      send: (msg) => received.push(msg),
    });

    const handler = managers[0]!.lastConnectOptions?.extraContext?.requestScenarioChange;
    expect(typeof handler).toBe('function');

    await handler?.('kate');

    const directive = received.find((msg) => msg.event === 'voice_control')
      ?.data as VoiceControlDirective | undefined;
    expect(directive).toEqual({
      action: 'switchScenario',
      scenarioKey: 'kate',
    });

    unsubscribe();
  });

  it('emits voice_control events when the realtime agent requests an agent handoff', async () => {
    const received: SessionStreamMessage[] = [];
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const unsubscribe = host.subscribe(sessionId, {
      id: 'voice_listener_agent',
      send: (msg) => received.push(msg),
    });

    const handler = managers[0]!.lastConnectOptions?.extraContext?.requestAgentChange;
    expect(typeof handler).toBe('function');

    await handler?.('returnsAgent');

    const directive = received.find((msg) => msg.event === 'voice_control')
      ?.data as VoiceControlDirective | undefined;
    expect(directive).toEqual({
      action: 'switchAgent',
      agentName: 'returnsAgent',
    });

    unsubscribe();
  });

  it('wraps session creation in tracing with a descriptive name', async () => {
    const traceMock = vi.mocked(getOrCreateTrace);

    await host.createSession({ agentSetKey: 'demo' });

    expect(traceMock).toHaveBeenCalledTimes(1);
    const [, options] = traceMock.mock.calls[0] ?? [];
    expect(options?.name).toBe('session:create:demo');
  });

  it('schedules hotword reminder once and destroys session after timeout', async () => {
    vi.useFakeTimers();
    host = new SessionHost({
      hotwordReminderEnabled: true,
      hotwordReminderDisconnectDelayMs: 20,
      scenarioMap,
      sessionManagerFactory: (hooks) => {
        const mgr = new FakeSessionManager(hooks);
        managers.push(mgr);
        return mgr;
      },
      now: () => Date.now(),
      envInspector: () => envSnapshot,
      hotwordCueService,
      responsesClientFactory: () => responsesClient as any,
      intentClassifier,
    });
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const context: any = (host as any).sessions.get(sessionId);

    (host as any).handleHotwordTimeout(context);
    (host as any).handleHotwordTimeout(context);

    expect(context.hotwordReminderTimer).toBeDefined();
    vi.runAllTimers();
    expect((host as any).sessions.has(sessionId)).toBe(false);
    vi.useRealTimers();
  });

  it('destroys session only once when called multiple times', async () => {
    const { sessionId } = await host.createSession({ agentSetKey: 'demo' });
    const manager = managers[0]!;
    await host.destroySession(sessionId, { reason: 'test' });
    await host.destroySession(sessionId, { reason: 'test-again' });
    expect(manager.getStatus()).toBe('DISCONNECTED');
  });
});
