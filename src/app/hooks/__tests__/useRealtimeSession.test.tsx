import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { createTransportEventHandler, useRealtimeSession } from '../useRealtimeSession';

const logClientEvent = vi.fn();
const logServerEvent = vi.fn();
const setSessionMetadata = vi.fn();
const generateRequestId = vi.fn(() => 'req-test');

vi.mock('../../contexts/EventContext', () => ({
  useEvent: () => ({
    logClientEvent,
    logServerEvent,
    setSessionMetadata,
    generateRequestId,
  }),
}));

const historyHandlerSpies = {
  handleAgentToolStart: vi.fn(),
  handleAgentToolEnd: vi.fn(),
  handleHistoryUpdated: vi.fn(),
  handleHistoryAdded: vi.fn(),
  handleTranscriptionDelta: vi.fn(),
  handleTranscriptionCompleted: vi.fn(),
  handleGuardrailTripped: vi.fn(),
};

vi.mock('../useHandleSessionHistory', () => ({
  useHandleSessionHistory: () => ({ current: historyHandlerSpies }),
}));

const audioPlayerMock = vi.hoisted(() => ({
  enqueue: vi.fn(),
  close: vi.fn(),
  setMuted: vi.fn(),
  stop: vi.fn(),
}));
const pcmPlayerCtor = vi.hoisted(() =>
  vi.fn(function MockedPcmAudioPlayer() {
    return audioPlayerMock;
  }),
);

vi.mock('@/app/lib/audio/pcmPlayer', () => ({
  PcmAudioPlayer: pcmPlayerCtor,
}));

describe('useRealtimeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(historyHandlerSpies).forEach((spy) => spy.mockReset());
    audioPlayerMock.enqueue.mockReset();
    audioPlayerMock.close.mockReset();
    audioPlayerMock.setMuted.mockReset();
    audioPlayerMock.stop.mockReset();
    pcmPlayerCtor.mockClear();
    delete (window as any).__MCPC_BFF_KEY;
  });

  it('forwards the outputText capability to the session API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createMockResponse({
        sessionId: 'sess_1',
        streamUrl: '/api/session/sess_1/stream',
        allowedModalities: ['audio'],
        capabilityWarnings: [],
      }),
    );
    const stubEventSource = createStubEventSource();

    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({
        agentSetKey: 'demo',
        clientCapabilities: { outputText: false },
      });
    });

    const requestInit = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse((requestInit!.body ?? '{}') as string);
    expect(body.clientCapabilities).toEqual({ audio: true, outputText: false });
  });

  it('sends the injected BFF key with session API calls when present at runtime', async () => {
    (window as any).__MCPC_BFF_KEY = 'runtime-bff-key';

    const fetchImpl = vi.fn().mockResolvedValue(
      createMockResponse({
        sessionId: 'sess_bff',
        streamUrl: '/api/session/sess_bff/stream',
        allowedModalities: ['audio'],
        capabilityWarnings: [],
      }),
    );
    const stubEventSource = createStubEventSource();

    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const headers = (fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-bff-key']).toBe('runtime-bff-key');
  });

  it('exposes sendAudioChunk that suppresses commit/response by default', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          sessionId: 'sess_pcm',
          streamUrl: '/api/session/sess_pcm/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      )
      .mockResolvedValue(createMockResponse({ accepted: true }));
    const stubEventSource = createStubEventSource();
    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    await act(async () => {
      await result.current.sendAudioChunk('BASE64_CHUNK');
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, eventArgs] = fetchImpl.mock.calls;
    expect(eventArgs?.[0]).toBe('/api/session/sess_pcm/event');
    const body = JSON.parse((eventArgs?.[1]?.body ?? '{}') as string);
    expect(body).toEqual({
      kind: 'input_audio',
      audio: 'BASE64_CHUNK',
      commit: false,
      response: false,
    });
  });

  it('allows overriding commit/response flags when sending audio chunks', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          sessionId: 'sess_pcm2',
          streamUrl: '/api/session/sess_pcm2/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      )
      .mockResolvedValue(createMockResponse({ accepted: true }));
    const stubEventSource = createStubEventSource();
    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    await act(async () => {
      await result.current.sendAudioChunk('FINAL_CHUNK', { commit: true, response: true });
    });

    const [, eventArgs] = fetchImpl.mock.calls;
    const body = JSON.parse((eventArgs?.[1]?.body ?? '{}') as string);
    expect(body.commit).toBe(true);
    expect(body.response).toBe(true);
  });

  it('stops local playback when interrupt is triggered', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createMockResponse({
          sessionId: 'sess_interrupt',
          streamUrl: '/api/session/sess_interrupt/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      )
      .mockResolvedValue(createMockResponse({ accepted: true }));
    const stubEventSource = createStubEventSource();
    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const transportListener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'transport_event',
    )?.[1];

    if (transportListener) {
      await act(async () => {
        transportListener({
          data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'PCM' }),
        } as MessageEvent<string>);
      });
    }

    await act(async () => {
      result.current.interrupt();
      await Promise.resolve();
    });

    expect(audioPlayerMock.stop).toHaveBeenCalled();
    const [, eventArgs] = fetchImpl.mock.calls;
    expect(eventArgs?.[0]).toBe('/api/session/sess_interrupt/event');
    const body = JSON.parse((eventArgs?.[1]?.body ?? '{}') as string);
    expect(body).toEqual({ kind: 'control', action: 'interrupt' });
  });

  it('notifies onReady when the session emits a ready event', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_ready',
          streamUrl: '/api/session/sess_ready/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();
    const readyCallback = vi.fn();

    const { result } = renderHook(() =>
      useRealtimeSession(
        { onReady: readyCallback },
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const readyListener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'ready',
    )?.[1];
    expect(readyListener).toBeInstanceOf(Function);

    await act(async () => {
      readyListener?.({ data: JSON.stringify({ sessionId: 'sess_ready' }) } as MessageEvent<string>);
    });

    expect(readyCallback).toHaveBeenCalledWith({ sessionId: 'sess_ready' });
  });

  it('propagates voice_control events to the provided callback', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_voice',
          streamUrl: '/api/session/sess_voice/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();
    const voiceCallback = vi.fn();

    const { result } = renderHook(() =>
      useRealtimeSession(
        {
          onVoiceControlDirective: voiceCallback,
        },
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const listener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'voice_control',
    )?.[1];
    expect(listener).toBeInstanceOf(Function);

    await act(async () => {
      listener?.({
        data: JSON.stringify({ action: 'switchScenario', scenarioKey: 'kate' }),
      } as MessageEvent<string>);
    });

    expect(voiceCallback).toHaveBeenCalledWith({
      action: 'switchScenario',
      scenarioKey: 'kate',
    });
  });

  it('invokes onHotwordCue when SSE event arrives', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_hotword',
          streamUrl: '/api/session/sess_hotword/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();
    const cueCallback = vi.fn();

    const { result } = renderHook(() =>
      useRealtimeSession(
        { onHotwordCue: cueCallback },
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const listener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'hotword_cue',
    )?.[1];
    expect(listener).toBeInstanceOf(Function);

    await act(async () => {
      listener?.({
        data: JSON.stringify({ status: 'streamed', scenarioKey: 'demo', audio: 'SERVER_PCM' }),
      } as MessageEvent<string>);
    });

    expect(cueCallback).toHaveBeenCalledWith({ status: 'streamed', scenarioKey: 'demo', audio: 'SERVER_PCM' });
    expect(audioPlayerMock.enqueue).toHaveBeenCalledWith('SERVER_PCM');
  });

  it('plays a fallback cue locally when the server requests fallback playback', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_hotword_fallback',
          streamUrl: '/api/session/sess_hotword_fallback/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();
    const fallbackResponse = {
      ok: true,
      arrayBuffer: async () => createTestWavBuffer(),
    } as Response;
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = vi.fn().mockResolvedValue(fallbackResponse);

    try {
      const { result } = renderHook(() =>
        useRealtimeSession(
          {},
          {
            fetchImpl,
            createEventSource: () => stubEventSource,
          },
        ),
      );

      await act(async () => {
        await result.current.connect({ agentSetKey: 'demo' });
      });

      const listener = stubEventSource.addEventListener.mock.calls.find(
        ([eventName]) => eventName === 'hotword_cue',
      )?.[1];
      expect(listener).toBeInstanceOf(Function);

      await act(async () => {
        listener?.({
          data: JSON.stringify({ status: 'fallback', cueId: 'cue_fail' }),
        } as MessageEvent<string>);
      });

      await vi.waitFor(() => {
        expect((globalThis as any).fetch).toHaveBeenCalledWith('/audio/hotword-chime.wav');
        expect(audioPlayerMock.enqueue).toHaveBeenCalled();
      });
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it('keeps the session status when a recoverable session_error arrives', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_error',
          streamUrl: '/api/session/sess_error/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();

    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const statusListener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'status',
    )?.[1];
    const errorListener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'session_error',
    )?.[1];

    await act(async () => {
      statusListener?.({
        data: JSON.stringify({ status: 'CONNECTED' }),
      } as MessageEvent<string>);
    });
    expect(result.current.status).toBe('CONNECTED');

    await act(async () => {
      errorListener?.({
        data: JSON.stringify({ code: 'invalid_value', message: 'recoverable' }),
      } as MessageEvent<string>);
    });

    expect(result.current.status).toBe('CONNECTED');
  });

  it('marks status as CONNECTING (not DISCONNECTED) when SSE stream errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_sse_error',
          streamUrl: '/api/session/sess_sse_error/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );
    const stubEventSource = createStubEventSource();

    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource: () => stubEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    const statusListener = stubEventSource.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'status',
    )?.[1];

    await act(async () => {
      statusListener?.({
        data: JSON.stringify({ status: 'CONNECTED' }),
      } as MessageEvent<string>);
    });
    expect(result.current.status).toBe('CONNECTED');

    await act(async () => {
      stubEventSource.triggerError();
    });

    expect(result.current.status).toBe('CONNECTING');
  });

  it('re-subscribes to SSE stream after an error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({
          sessionId: 'sess_reopen',
          streamUrl: '/api/session/sess_reopen/stream',
          allowedModalities: ['audio'],
          capabilityWarnings: [],
        }),
      );

    const first = createStubEventSource();
    const second = createStubEventSource();
    const createEventSource = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const { result } = renderHook(() =>
      useRealtimeSession(
        {},
        {
          fetchImpl,
          createEventSource,
        },
      ),
    );

    await act(async () => {
      await result.current.connect({ agentSetKey: 'demo' });
    });

    // initial connection acknowledged
    const firstStatus = first.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'status',
    )?.[1];
    await act(async () => {
      firstStatus?.({ data: JSON.stringify({ status: 'CONNECTED' }) } as MessageEvent<string>);
    });
    expect(result.current.status).toBe('CONNECTED');

    await act(async () => {
      first.triggerError();
    });

    expect(createEventSource).toHaveBeenCalledTimes(2);
    const secondStatus = second.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'status',
    )?.[1];

    await act(async () => {
      secondStatus?.({ data: JSON.stringify({ status: 'CONNECTED' }) } as MessageEvent<string>);
    });

    expect(result.current.status).toBe('CONNECTED');
  });
});

describe('createTransportEventHandler', () => {
  it('routes audio deltas to the PCM player when unmuted', () => {
    const enqueue = vi.fn();
    const handler = createTransportEventHandler({
      ensureAudioPlayer: () => ({ enqueue } as any),
      historyHandlers: {
        handleTranscriptionCompleted: vi.fn(),
        handleTranscriptionDelta: vi.fn(),
      },
      audioMutedRef: { current: false },
      textOutputEnabledRef: { current: true },
    });

    handler({ type: 'response.output_audio.delta', delta: 'pcm-chunk' });
    expect(enqueue).toHaveBeenCalledWith('pcm-chunk');
  });

  it('skips transcription handlers when text output is disabled', () => {
    const historyHandlers = {
      handleTranscriptionCompleted: vi.fn(),
      handleTranscriptionDelta: vi.fn(),
    };
    const handler = createTransportEventHandler({
      ensureAudioPlayer: () => ({ enqueue: vi.fn() } as any),
      historyHandlers,
      audioMutedRef: { current: false },
      textOutputEnabledRef: { current: false },
    });

    handler({ type: 'response.output_text.delta', delta: 'partial text' });
    handler({
      type: 'response.output_text.done',
      transcript: 'final text',
    });

    expect(historyHandlers.handleTranscriptionDelta).not.toHaveBeenCalled();
    expect(historyHandlers.handleTranscriptionCompleted).not.toHaveBeenCalled();
  });

  it('invokes transcription handlers when text output is enabled', () => {
    const historyHandlers = {
      handleTranscriptionCompleted: vi.fn(),
      handleTranscriptionDelta: vi.fn(),
    };
    const handler = createTransportEventHandler({
      ensureAudioPlayer: () => ({ enqueue: vi.fn() } as any),
      historyHandlers,
      audioMutedRef: { current: true },
      textOutputEnabledRef: { current: true },
    });

    handler({ type: 'response.output_text.delta', delta: 'partial text' });
    handler({
      type: 'response.output_text.done',
      transcript: 'final text',
      item_id: 'item-42',
    });

    expect(historyHandlers.handleTranscriptionDelta).toHaveBeenCalledWith(
      expect.objectContaining({ delta: 'partial text' }),
    );
    expect(historyHandlers.handleTranscriptionCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'final text', item_id: 'item-42' }),
    );
  });
});

function createMockResponse(body: any, ok = true) {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function createStubEventSource(): EventSource {
  const listeners = new Map<string, Array<(evt: MessageEvent<string>) => void>>();
  const addEventListener = vi.fn(
    (event: string, handler: (evt: MessageEvent<string>) => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, [...current, handler]);
    },
  );
  const removeEventListener = vi.fn(
    (event: string, handler: (evt: MessageEvent<string>) => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(
        event,
        current.filter((h) => h !== handler),
      );
    },
  );
  const close = vi.fn();

  const stub: any = {
    addEventListener,
    removeEventListener,
    close,
    onerror: null as any,
    emit(event: string, payload: any) {
      const handlers = listeners.get(event) ?? [];
      const data =
        typeof payload === 'string'
          ? payload
          : JSON.stringify(payload ?? {});
      handlers.forEach((h) => h({ data } as MessageEvent<string>));
    },
    triggerError() {
      if (typeof stub.onerror === 'function') {
        stub.onerror(new Event('error') as Event);
      }
    },
  };

  return stub as EventSource & {
    emit: (event: string, payload: any) => void;
    triggerError: () => void;
  };
}

function createTestWavBuffer(): ArrayBuffer {
  const headerSize = 44;
  const sampleCount = 16;
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 24000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const pcm = new Int16Array(buffer, headerSize, sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm[i] = i % 2 === 0 ? 4000 : -4000;
  }
  return buffer;
}
