import { MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useEvent } from '../contexts/EventContext';
import { useHandleSessionHistory } from './useHandleSessionHistory';
import { SessionStatus } from '../types';
import { PcmAudioPlayer } from '@/app/lib/audio/pcmPlayer';
import { createConsoleMetricEmitter } from '../../../framework/metrics/metricEmitter';
import type { SessionCommand } from '../../../services/api/bff/sessionHost';
import { getTranscriptionEventStage } from '@/shared/realtimeTranscriptionEvents';
import { isVoiceControlDirective, type VoiceControlDirective } from '@/shared/voiceControl';

const BUILD_TIME_BFF_KEY = process.env.NEXT_PUBLIC_BFF_KEY;
const CLIENT_DISCONNECT_REASON = 'client_request';
const HOTWORD_CUE_ASSET_PATH = '/audio/4-ESM_Airy_Echo_Metallic_Alert_Notification_Synth_Electronic_Particle_Cute_Cartoon.wav';

function addFallbackItemId(event: any) {
  if (!event || typeof event !== 'object') return event;
  const fallbackId =
    event.item_id ??
    event.itemId ??
    event.item?.id ??
    event.response_id ??
    event.responseId ??
    event.id ??
    null;
  return fallbackId && event.item_id !== fallbackId
    ? {
        ...event,
        item_id: fallbackId,
      }
    : event;
}

function transcriptTextFromEvent(event: any, field: 'transcript' | 'delta') {
  const value = event?.[field] ?? event?.text ?? event?.delta ?? '';
  return typeof value === 'string' ? value : '';
}

function safeJsonParse<T = any>(input: string): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return input as any;
  }
}

export interface HotwordCueEventPayload {
  cueId?: string;
  scenarioKey?: string;
  status: 'streamed' | 'fallback';
  reason?: string;
}

export interface RealtimeSessionCallbacks {
  onConnectionChange?: (status: SessionStatus) => void;
  onAgentHandoff?: (agentName: string) => void;
  onVoiceControlDirective?: (directive: VoiceControlDirective) => void;
  onHotwordCue?: (event: HotwordCueEventPayload) => void;
  onReady?: (payload: Record<string, any>) => void;
}

export interface ClientCapabilityOverrides {
  audio?: boolean;
  images?: boolean;
  outputText?: boolean;
}

export interface SendAudioChunkOptions {
  commit?: boolean;
  response?: boolean;
}

export interface SendImageOptions {
  text?: string;
  triggerResponse?: boolean;
}

export interface ConnectOptions {
  agentSetKey: string;
  preferredAgentName?: string;
  extraContext?: Record<string, any>;
  clientCapabilities?: ClientCapabilityOverrides;
  clientTag?: string;
}

export interface RealtimeSessionHookOverrides {
  fetchImpl?: typeof fetch;
  createEventSource?: (url: string) => EventSource;
}

export interface RealtimeSessionConfig {
  defaultCapabilities?: ClientCapabilityOverrides;
}

interface ActiveSessionState {
  sessionId: string;
  streamUrl: string;
  eventSource: EventSource;
}

type TransportHistoryHandlers = Pick<
  ReturnType<typeof useHandleSessionHistory>['current'],
  'handleTranscriptionCompleted' | 'handleTranscriptionDelta'
>;

export interface TransportEventHandlerDeps {
  ensureAudioPlayer: () => PcmAudioPlayer;
  historyHandlers: TransportHistoryHandlers;
  audioMutedRef: MutableRefObject<boolean>;
  textOutputEnabledRef: MutableRefObject<boolean>;
}

export function createTransportEventHandler({
  ensureAudioPlayer,
  historyHandlers,
  audioMutedRef,
  textOutputEnabledRef,
}: TransportEventHandlerDeps) {
  return (event: any) => {
    const eventType = event?.type;
    if (eventType === 'response.output_audio.delta' && typeof event?.delta === 'string') {
      if (!audioMutedRef.current) {
        void ensureAudioPlayer().enqueue(event.delta);
      }
    }

    const stage = getTranscriptionEventStage(event);
    if (!stage || !textOutputEnabledRef.current) {
      return;
    }

    const payloadKey = stage === 'completed' ? 'transcript' : 'delta';
    const normalized = addFallbackItemId({
      ...event,
      [payloadKey]: transcriptTextFromEvent(event, payloadKey),
    });

    if (stage === 'completed') {
      historyHandlers.handleTranscriptionCompleted(normalized);
    } else {
      historyHandlers.handleTranscriptionDelta(normalized);
    }
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function useRealtimeSession(
  callbacks: RealtimeSessionCallbacks = {},
  overrides: RealtimeSessionHookOverrides = {},
  config: RealtimeSessionConfig = {},
) {
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const createEventSource =
    overrides.createEventSource ?? ((url: string) => new EventSource(url));

  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');
  const sessionStateRef = useRef<ActiveSessionState | null>(null);
  const listenerCleanupRef = useRef<(() => void) | null>(null);
  const sessionMetadataRef = useRef<{ sessionId: string | null }>({ sessionId: null });
  const defaultCapabilitiesRef = useRef<ClientCapabilityOverrides>({
    audio: config.defaultCapabilities?.audio ?? true,
    images: config.defaultCapabilities?.images,
    outputText: config.defaultCapabilities?.outputText ?? true,
  });
  const serverTextOutputEnabledRef = useRef(true);
  const metricEmitterRef = useRef(createConsoleMetricEmitter('client.session_manager'));
  const audioPlayerRef = useRef<PcmAudioPlayer | null>(null);
  const audioMutedRef = useRef(false);
  const hotwordCueBase64Ref = useRef<string | null>(null);
  const hotwordCueFetchPromiseRef = useRef<Promise<string> | null>(null);

  const { logClientEvent, logServerEvent, setSessionMetadata, generateRequestId } = useEvent();
  const historyHandlers = useHandleSessionHistory().current;

  const assignSessionId = useCallback(() => {
    const nextSessionId = generateRequestId();
    sessionMetadataRef.current.sessionId = nextSessionId;
    setSessionMetadata({ sessionId: nextSessionId });
    return nextSessionId;
  }, [generateRequestId, setSessionMetadata]);

  const clearSessionId = useCallback(() => {
    sessionMetadataRef.current.sessionId = null;
    setSessionMetadata({ sessionId: null });
  }, [setSessionMetadata]);

  const updateStatus = useCallback(
    (s: SessionStatus) => {
      setStatus(s);
      callbacks.onConnectionChange?.(s);
      logClientEvent({ type: 'session_status', status: s }, 'session_status');
    },
    [callbacks, logClientEvent],
  );

  const ensureAudioPlayer = useCallback(() => {
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new PcmAudioPlayer();
    }
    return audioPlayerRef.current;
  }, []);

  const stopAudioPlayback = useCallback(() => {
    audioPlayerRef.current?.stop();
  }, []);

  const fetchHotwordCueBase64 = useCallback(async () => {
    if (hotwordCueBase64Ref.current) {
      return hotwordCueBase64Ref.current;
    }
    if (!hotwordCueFetchPromiseRef.current) {
      hotwordCueFetchPromiseRef.current = fetch(HOTWORD_CUE_ASSET_PATH)
        .then((response) => {
          if (!response.ok) {
            throw new Error('Failed to load hotword cue asset');
          }
          return response.arrayBuffer();
        })
        // WAVヘッダごとBase64にして、再生側でサンプルレートを尊重してデコードする
        .then((buffer) => arrayBufferToBase64(buffer));
    }
    const base64 = await hotwordCueFetchPromiseRef.current;
    hotwordCueBase64Ref.current = base64;
    return base64;
  }, []);

  const playLocalHotwordCue = useCallback(async () => {
    try {
      const base64 = await fetchHotwordCueBase64();
      if (!audioMutedRef.current) {
        void ensureAudioPlayer().enqueue(base64);
      }
    } catch (error) {
      console.warn('Failed to play local hotword cue', error);
    }
  }, [fetchHotwordCueBase64, ensureAudioPlayer]);

  const transportEventHandler = useMemo(
    () =>
      createTransportEventHandler({
        ensureAudioPlayer,
        historyHandlers: {
          handleTranscriptionCompleted: historyHandlers.handleTranscriptionCompleted,
          handleTranscriptionDelta: historyHandlers.handleTranscriptionDelta,
        },
        audioMutedRef,
        textOutputEnabledRef: serverTextOutputEnabledRef,
      }),
    [
      ensureAudioPlayer,
      historyHandlers.handleTranscriptionCompleted,
      historyHandlers.handleTranscriptionDelta,
    ],
  );

  const detachStreamListeners = useCallback(() => {
    listenerCleanupRef.current?.();
    listenerCleanupRef.current = null;
  }, []);

  const registerStreamListeners = useCallback(
    (source: EventSource) => {
      detachStreamListeners();
      const disposers: Array<() => void> = [];

      const reopenStream = async () => {
        const active = sessionStateRef.current;
        if (!active) {
          updateStatus('DISCONNECTED');
          return;
        }
        try {
          const newSource = createEventSource(active.streamUrl);
          sessionStateRef.current = {
            ...active,
            eventSource: newSource,
          };
          registerStreamListeners(newSource);
        } catch (error) {
          console.error('Failed to reopen SSE stream', error);
          updateStatus('DISCONNECTED');
        }
      };

      const addListener = (
        event: string,
        handler: (payload: any) => void,
      ) => {
        const wrapped = (evt: MessageEvent<string>) => {
          handler(safeJsonParse(evt.data));
        };
        source.addEventListener(event, wrapped as any);
        disposers.push(() => source.removeEventListener(event, wrapped as any));
      };

      addListener('agent_handoff', (payload) => {
        const handoffName = payload?.target ?? payload?.handoff?.name;
        if (typeof handoffName === 'string') {
          callbacks.onAgentHandoff?.(handoffName);
        }
      });
      addListener('agent_tool_start', (payload) => {
        const args = Array.isArray(payload)
          ? payload
          : [payload, undefined, undefined];
        historyHandlers.handleAgentToolStart(...(args as [any, any, any]));
      });
      addListener('agent_tool_end', (payload) => {
        const args = Array.isArray(payload)
          ? payload
          : [payload, undefined, undefined, undefined];
        historyHandlers.handleAgentToolEnd(...(args as [any, any, any, any]));
      });
      addListener('history_updated', historyHandlers.handleHistoryUpdated);
      addListener('history_added', historyHandlers.handleHistoryAdded);
      addListener('guardrail_tripped', (payload) => {
        const args = Array.isArray(payload)
          ? payload
          : [payload, undefined, undefined];
        historyHandlers.handleGuardrailTripped(...(args as [any, any, any]));
      });
      addListener('transport_event', transportEventHandler);
      addListener('status', (payload) => {
        if (payload?.status) {
          updateStatus(payload.status as SessionStatus);
        }
      });
      addListener('heartbeat', (payload) => {
        logServerEvent({ type: 'heartbeat', payload }, 'heartbeat');
      });
      addListener('ready', (payload) => {
        logServerEvent({ type: 'ready', payload }, 'ready');
        callbacks.onReady?.(payload ?? {});
      });
      addListener('session_error', (payload) => {
        logServerEvent({ type: 'session_error', payload }, 'session_error');
        logClientEvent(
          {
            type: 'session_error',
            code: payload?.code,
            message: payload?.message ?? 'Realtime session error',
            status: payload?.status,
          },
          'session_error',
        );
        // サーバ側でセッションが強制終了された場合、クライアント状態を即座に切断扱いにする
        detachStreamListeners();
        sessionStateRef.current?.eventSource.close();
        sessionStateRef.current = null;
        updateStatus('DISCONNECTED');
      });
      addListener('voice_control', (payload) => {
        if (isVoiceControlDirective(payload)) {
          callbacks.onVoiceControlDirective?.(payload);
        }
      });
      addListener('hotword_cue', (payload) => {
        callbacks.onHotwordCue?.(payload);
        if (payload?.audio && payload?.status === 'streamed') {
          if (!audioMutedRef.current) {
            void ensureAudioPlayer().enqueue(payload.audio);
          }
        } else if (payload?.status === 'fallback') {
          void playLocalHotwordCue();
        }
      });

      source.onerror = (event) => {
        console.error('SSE error from BFF session stream', event);
        updateStatus('CONNECTING');
        void reopenStream();
      };

      listenerCleanupRef.current = () => {
        disposers.forEach((dispose) => dispose());
        source.close();
      };
    },
    [
      callbacks,
      detachStreamListeners,
      historyHandlers,
      logClientEvent,
      logServerEvent,
      transportEventHandler,
      createEventSource,
      updateStatus,
      playLocalHotwordCue,
      ensureAudioPlayer,
    ],
  );

  const disconnect = useCallback(async () => {
    const active = sessionStateRef.current;
    if (!active) return;

    detachStreamListeners();
    active.eventSource.close();
    sessionStateRef.current = null;
    serverTextOutputEnabledRef.current = true;
    audioPlayerRef.current?.close();
    audioPlayerRef.current = null;
    clearSessionId();
    updateStatus('DISCONNECTED');

    try {
      const reasonParam = `reason=${encodeURIComponent(CLIENT_DISCONNECT_REASON)}`;
      await fetchImpl(`/api/session/${active.sessionId}?${reasonParam}`, {
        method: 'DELETE',
        headers: buildHeaders(),
      });
    } catch (error) {
      console.warn('Failed to delete session', error);
    }
  }, [clearSessionId, detachStreamListeners, fetchImpl, updateStatus]);

  const connect = useCallback(
    async ({ agentSetKey, preferredAgentName, extraContext, clientCapabilities, clientTag }: ConnectOptions) => {
      if (sessionStateRef.current) {
        console.info('Session already active, ignoring connect request');
        return;
      }

      assignSessionId();
      updateStatus('CONNECTING');

      const resolvedCapabilities = {
        audio: clientCapabilities?.audio ?? defaultCapabilitiesRef.current.audio ?? true,
        outputText:
          clientCapabilities?.outputText ?? defaultCapabilitiesRef.current.outputText ?? true,
        images: clientCapabilities?.images ?? defaultCapabilitiesRef.current.images,
      };
      const clientCapabilitiesPayload: ClientCapabilityOverrides = {
        audio: resolvedCapabilities.audio,
        outputText: resolvedCapabilities.outputText,
      };
      if (typeof resolvedCapabilities.images === 'boolean') {
        clientCapabilitiesPayload.images = resolvedCapabilities.images;
      }

      const response = await fetchImpl('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(),
        },
        body: JSON.stringify({
          agentSetKey,
          preferredAgentName,
          metadata: extraContext ?? {},
          clientCapabilities: clientCapabilitiesPayload,
          clientTag,
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        logClientEvent(errorPayload, 'error.session_create_failed');
        updateStatus('DISCONNECTED');
        throw new Error('Failed to create session');
      }

      const data = await response.json();

      if (Array.isArray(data.capabilityWarnings) && data.capabilityWarnings.length > 0) {
        logClientEvent(
          {
            type: 'session_warning',
            warnings: data.capabilityWarnings,
          },
          'session_warning',
        );
      }

      const allowedModalities: string[] = Array.isArray(data.allowedModalities)
        ? data.allowedModalities
        : [];
      const hasAudio = allowedModalities.includes('audio');
      const serverTextOutputEnabled =
        typeof data.textOutputEnabled === 'boolean'
          ? Boolean(data.textOutputEnabled)
          : resolvedCapabilities.outputText;
      serverTextOutputEnabledRef.current = serverTextOutputEnabled;

      if (allowedModalities.length > 0 && !hasAudio) {
        logClientEvent(
          {
            type: 'session_warning',
            message: 'Audio output disabled by server capabilities.',
          },
          'session_warning',
        );
      }
      if (resolvedCapabilities.outputText && !serverTextOutputEnabled) {
        logClientEvent(
          {
            type: 'session_warning',
            message: 'Text output disabled by server capabilities.',
          },
          'session_warning',
        );
      }
      const streamUrl = appendBffKeyToUrl(data.streamUrl);
      const eventSource = createEventSource(streamUrl);
      sessionStateRef.current = {
        sessionId: data.sessionId,
        streamUrl,
        eventSource,
      };
      registerStreamListeners(eventSource);
      return {
        sessionId: data.sessionId,
        memoryKey: typeof data.memoryKey === 'string' ? data.memoryKey : null,
      };
    },
    [assignSessionId, createEventSource, fetchImpl, logClientEvent, registerStreamListeners, updateStatus],
  );

  const disconnectRef = useRef(disconnect);
  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  useEffect(() => {
    return () => {
      const fn = disconnectRef.current;
      if (fn) {
        void fn();
      }
    };
  }, []);

  const postSessionCommand = useCallback(
    async (command: SessionCommand) => {
      const active = sessionStateRef.current;
      if (!active) {
        logClientEvent(
          {
            type: 'session_warning',
            message: 'Command ignored because session is not connected',
          },
          'session_warning',
        );
        throw new Error('Session is not connected');
      }

      const response = await fetchImpl(`/api/session/${active.sessionId}/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildHeaders(),
        },
        body: JSON.stringify(command),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        logClientEvent(payload, 'error.forward_event_failed');
        throw new Error('Failed to forward event to BFF');
      }

      metricEmitterRef.current.increment('session_events_total', 1, {
        kind: command.kind,
      });
    },
    [fetchImpl, logClientEvent],
  );

  const sendAudioChunk = useCallback(
    async (audioBase64: string, options: SendAudioChunkOptions = {}) => {
      if (!audioBase64) return;
      await postSessionCommand({
        kind: 'input_audio',
        audio: audioBase64,
        commit: options.commit ?? false,
        response: options.response ?? false,
      });
    },
    [postSessionCommand],
  );

  const sendUserText = useCallback(
    (text: string) => {
      void postSessionCommand({ kind: 'input_text', text });
    },
    [postSessionCommand],
  );

  const sendEvent = useCallback(
    (ev: any) => {
      void postSessionCommand({ kind: 'event', event: ev });
    },
    [postSessionCommand],
  );

  const sendImage = useCallback(
    async (file: File, options: SendImageOptions = {}) => {
      const active = sessionStateRef.current;
      if (!active) {
        logClientEvent(
          { type: 'session_warning', message: 'Image ignored because session is not connected' },
          'session_warning',
        );
        throw new Error('Session is not connected');
      }

      const formData = new FormData();
      formData.append('file', file);
      if (options.text) {
        formData.append('text', options.text);
      }
      if (options.triggerResponse === false) {
        formData.append('triggerResponse', 'false');
      }

      const response = await fetchImpl(`/api/session/${active.sessionId}/event`, {
        method: 'POST',
        headers: {
          ...buildHeaders(),
        },
        body: formData,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const reason = payload?.message || payload?.error || 'Failed to forward image event to BFF';
        logClientEvent(payload, 'error.forward_event_failed');
        throw new Error(reason);
      }

      metricEmitterRef.current.increment('session_events_total', 1, { kind: 'input_image' });
      return response.json().catch(() => ({}));
    },
    [fetchImpl, logClientEvent],
  );

  const mute = useCallback(
    (muted: boolean) => {
      audioMutedRef.current = muted;
      audioPlayerRef.current?.setMuted(muted);
      void postSessionCommand({ kind: 'control', action: 'mute', value: muted }).catch(() => {});
    },
    [postSessionCommand],
  );

  const interrupt = useCallback(() => {
    stopAudioPlayback();
    void postSessionCommand({ kind: 'control', action: 'interrupt' });
  }, [postSessionCommand, stopAudioPlayback]);

  const pushToTalkStart = useCallback(() => {
    void postSessionCommand({ kind: 'control', action: 'push_to_talk_start' });
  }, [postSessionCommand]);

  const pushToTalkStop = useCallback(() => {
    void postSessionCommand({ kind: 'control', action: 'push_to_talk_stop' });
  }, [postSessionCommand]);

  return {
    status,
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    mute,
    pushToTalkStart,
    pushToTalkStop,
    interrupt,
    sendAudioChunk,
    sendImage,
  } as const;
}

function buildHeaders(): Record<string, string> {
  const bffKey = resolveBffKey();
  return bffKey ? { 'x-bff-key': bffKey } : {};
}

function appendBffKeyToUrl(streamUrl: string): string {
  const bffKey = resolveBffKey();
  if (!bffKey) {
    return streamUrl;
  }
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const parsed = new URL(streamUrl, base);
    parsed.searchParams.set('bffKey', bffKey);
    return parsed.toString();
  } catch {
    return streamUrl;
  }
}

function resolveBffKey(): string | undefined {
  if (typeof window !== 'undefined' && window.__MCPC_BFF_KEY) {
    return window.__MCPC_BFF_KEY;
  }
  return BUILD_TIME_BFF_KEY;
}
