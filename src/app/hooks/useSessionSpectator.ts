import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getTranscriptionEventStage } from '@/shared/realtimeTranscriptionEvents';
import type { SessionStatus, SpectatorDirective, SpectatorEventLog, SpectatorTranscript } from '../types';

type TranscriptStage = 'completed' | 'delta';

interface ConnectParams {
  sessionId?: string;
  clientTag?: string;
  bffKey?: string;
  baseUrl?: string;
  label?: string;
  agentSetKey?: string;
  scenarioKey?: string | null;
  memoryKey?: string | null;
  preserveHistory?: boolean;
}

interface NormalizedTranscriptEvent {
  itemId: string;
  text: string;
  stage: TranscriptStage;
  raw: any;
  role?: SpectatorTranscript['role'];
}

function buildUrl(params: ConnectParams): string {
  if (!params.sessionId) {
    throw new Error('sessionId is required to build stream URL');
  }
  const normalizedOrigin = buildOrigin(params.baseUrl);
  const url = new URL(`/api/session/${params.sessionId}/stream`, normalizedOrigin);
  if (params.bffKey) {
    url.searchParams.set('bffKey', params.bffKey);
  }
  // cache buster to avoid EventSource reuse in some browsers
  url.searchParams.set('_', Date.now().toString());
  return url.toString();
}

function buildOrigin(baseUrl?: string): string {
  const origin =
    baseUrl?.trim() ||
    (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

function safeJsonParse<T = any>(input: string): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return input as unknown as T;
  }
}

function fallbackItemId(event: any): string | null {
  if (!event || typeof event !== 'object') return null;
  return (
    event.item_id ??
    event.itemId ??
    event.item?.id ??
    event.response_id ??
    event.responseId ??
    event.id ??
    null
  );
}

function transcriptTextFromEvent(event: any, field: 'transcript' | 'delta'): string {
  const value = event?.[field] ?? event?.text ?? event?.delta ?? '';
  return typeof value === 'string' ? value : '';
}

function extractTextFromContentArray(contents: any[] | undefined): string {
  if (!Array.isArray(contents)) return '';
  return contents
    .map((c) => {
      if (typeof c?.text === 'string') return c.text;
      if (typeof c?.transcript === 'string') return c.transcript;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeHistoryEvent(payload: any): NormalizedTranscriptEvent | null {
  const item = payload?.item ?? payload;
  if (!item) return null;
  const itemId = item.id ?? item.item_id ?? item.itemId;
  if (!itemId) return null;
  const role = item.role;
  let text = '';
  if (Array.isArray(item.content)) {
    text = extractTextFromContentArray(item.content);
  } else if (typeof item.text === 'string') {
    text = item.text;
  }
  if (!text) return null;
  return {
    itemId,
    text,
    stage: 'completed',
    raw: { ...payload, item: { ...item, role } },
  };
}

export function normalizeTranscriptEvent(event: any): NormalizedTranscriptEvent | null {
  const stage = getTranscriptionEventStage(event);
  if (!stage) return null;
  const itemId = fallbackItemId(event);
  if (!itemId) return null;

  const role: SpectatorTranscript['role'] | undefined = (() => {
    const type = event?.type ?? '';
    if (type.includes('input_audio_transcription')) return 'user';
    if (type.includes('output_audio') || type.includes('output_text')) return 'assistant';
    const itemRole = event?.item?.role;
    if (itemRole === 'user' || itemRole === 'assistant') return itemRole;
    return undefined;
  })();

  const text =
    stage === 'completed'
      ? transcriptTextFromEvent(event, 'transcript') || transcriptTextFromEvent(event, 'delta')
      : transcriptTextFromEvent(event, 'delta');

  return {
    itemId,
    text,
    stage,
    raw: event,
    role,
  };
}

export function upsertTranscriptItems(
  prev: SpectatorTranscript[],
  payload: NormalizedTranscriptEvent,
): SpectatorTranscript[] {
  const now = Date.now();
  const status = payload.stage === 'completed' ? 'COMPLETED' as const : 'STREAMING' as const;
  const next: SpectatorTranscript[] = prev.map((item): SpectatorTranscript => {
    if (item.itemId !== payload.itemId) return item;
    const mergedText =
      payload.stage === 'completed'
        ? payload.text || item.text
        : `${item.text}${payload.text}`;
    return {
      ...item,
      text: mergedText,
      status,
      updatedAt: now,
      lastEventType: payload.raw?.type ?? item.lastEventType,
      role: (payload.role ?? item.role ?? payload.raw?.item?.role) as SpectatorTranscript['role'],
    };
  });

  const exists = next.some((item) => item.itemId === payload.itemId);
  if (!exists) {
    next.push({
      itemId: payload.itemId,
      text: payload.text,
      status,
      updatedAt: now,
      lastEventType: payload.raw?.type,
      role: (payload.role ?? payload.raw?.item?.role) as SpectatorTranscript['role'],
    });
  }

  // keep the most recent 50 transcripts to avoid unbounded growth
  return next.slice(-50);
}

function generateId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(16).slice(2)}`;
}

export interface SessionSpectatorState {
  status: SessionStatus;
  transcripts: SpectatorTranscript[];
  directives: SpectatorDirective[];
  events: SpectatorEventLog[];
  lastError: string | null;
  sessionId: string | null;
  activeClientTag: string | null;
  scenarioKey: string | null;
  memoryKey: string | null;
  connect: (params: ConnectParams) => Promise<void>;
  disconnect: () => void;
  resetMemory: () => Promise<{ ok: boolean; message?: string }>;
  isResettingMemory: boolean;
}

export function useSessionSpectator(): SessionSpectatorState {
  const [status, setStatus] = useState<SessionStatus>('DISCONNECTED');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [activeClientTag, setActiveClientTag] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<SpectatorTranscript[]>([]);
  const [directives, setDirectives] = useState<SpectatorDirective[]>([]);
  const [events, setEvents] = useState<SpectatorEventLog[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [scenarioKey, setScenarioKey] = useState<string | null>(null);
  const [memoryKey, setMemoryKey] = useState<string | null>(null);
  const [isResettingMemory, setIsResettingMemory] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastConnectParamsRef = useRef<ConnectParams | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 6;
  const connectRef = useRef<((params: ConnectParams) => Promise<void>) | null>(null);
  const hasConnectedOnceRef = useRef(false);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setStatus('DISCONNECTED');
    setActiveClientTag(null);
    setScenarioKey(null);
    setMemoryKey(null);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  const scheduleReconnect = useCallback(() => {
    const params = lastConnectParamsRef.current;
    if (!params?.clientTag) return;
    if (reconnectTimerRef.current) return;
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setLastError('再接続回数の上限に達したため停止しました');
      return;
    }
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(800 * 2 ** attempt, 10_000);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptsRef.current += 1;
      if (connectRef.current && lastConnectParamsRef.current) {
        void connectRef.current({ ...lastConnectParamsRef.current, preserveHistory: true });
      }
    }, delay);
  }, []);

  const resolveViaViewerApi = useCallback(async (params: ConnectParams): Promise<ConnectParams> => {
    const normalizedOrigin = buildOrigin(params.baseUrl);
    const url = new URL('/api/viewer/session', normalizedOrigin);
    url.searchParams.set('clientTag', params.clientTag ?? '');
    const headers: Record<string, string> = {};
    if (params.bffKey) {
      headers['x-bff-key'] = params.bffKey;
    }
    const response = await fetch(url.toString(), { headers });
    if (response.status === 404) {
      throw new Error('resolve_not_found');
    }
    if (response.status === 401) {
      throw new Error('resolve_unauthorized');
    }
    if (!response.ok) {
      throw new Error(`resolve_failed_${response.status}`);
    }
    const payload = await response.json();
    return {
      ...params,
      sessionId: payload.sessionId,
      agentSetKey: payload.scenarioKey ?? payload.agentSetKey ?? null,
      scenarioKey: payload.scenarioKey ?? payload.agentSetKey ?? null,
      memoryKey: payload.memoryKey ?? null,
    };
  }, []);

  const resolveViaLegacyApi = useCallback(async (params: ConnectParams): Promise<ConnectParams> => {
    const normalizedOrigin = buildOrigin(params.baseUrl);
    const url = new URL('/api/session/resolve', normalizedOrigin);
    url.searchParams.set('clientTag', params.clientTag ?? '');
    const headers: Record<string, string> = {};
    if (params.bffKey) {
      headers['x-bff-key'] = params.bffKey;
    }
    const response = await fetch(url.toString(), { headers });
    if (response.status === 404) {
      throw new Error('resolve_not_found');
    }
    if (response.status === 401) {
      throw new Error('resolve_unauthorized');
    }
    if (!response.ok) {
      throw new Error(`resolve_failed_${response.status}`);
    }
    const payload = await response.json();
    return {
      ...params,
      sessionId: payload.sessionId,
      agentSetKey: payload.agentSetKey ?? payload.scenarioKey ?? null,
      scenarioKey: payload.agentSetKey ?? payload.scenarioKey ?? null,
      memoryKey: payload.memoryKey ?? null,
    };
  }, []);

  const resolveSessionIdByTag = useCallback(
    async (params: ConnectParams): Promise<ConnectParams> => {
      let viewerError: Error | null = null;
      try {
        return await resolveViaViewerApi(params);
      } catch (error: any) {
        viewerError = error instanceof Error ? error : new Error(String(error?.message ?? error));
        if (viewerError.message === 'resolve_unauthorized') {
          throw viewerError;
        }
      }
      try {
        return await resolveViaLegacyApi(params);
      } catch (legacyError: any) {
        if (legacyError instanceof Error) {
          throw legacyError;
        }
        if (legacyError?.message) {
          throw new Error(String(legacyError.message));
        }
        if (viewerError) {
          throw viewerError;
        }
        throw new Error('resolve_failed');
      }
    },
    [resolveViaLegacyApi, resolveViaViewerApi],
  );

  const handleSseEvent = useCallback((eventName: string, data: any) => {
    setEvents((prev) => [
      {
        id: generateId('ev'),
        type: eventName,
        timestamp: Date.now(),
        data,
      },
      ...prev,
    ].slice(0, 60));

    if (eventName === 'status' && typeof data?.status === 'string') {
      const normalized = data.status.toUpperCase() as SessionStatus;
      setStatus(normalized);
      if (normalized === 'CONNECTED') {
        hasConnectedOnceRef.current = true;
      }
      if (normalized === 'DISCONNECTED' && hasConnectedOnceRef.current) {
        scheduleReconnect();
      }
      return;
    }

    if (eventName === 'transport_event') {
      const normalized = normalizeTranscriptEvent(data);
      if (normalized) {
        setTranscripts((prev) => upsertTranscriptItems(prev, normalized));
      }
      return;
    }

    if (eventName === 'history_added' || eventName === 'history_updated') {
      const normalized = normalizeHistoryEvent(data);
      if (normalized) {
        setTranscripts((prev) => upsertTranscriptItems(prev, normalized));
      }
      return;
    }

    if (eventName === 'voice_control') {
      if (data?.action === 'switchScenario' && typeof data?.scenarioKey === 'string') {
        setScenarioKey(String(data.scenarioKey));
      }
      setDirectives((prev) => [
        {
          id: generateId('vc'),
          action: data?.action ?? 'unknown',
          payload: data,
          timestamp: Date.now(),
        },
        ...prev,
      ].slice(0, 30));
      return;
    }

    if (eventName === 'session_error') {
      const message = data?.message ?? 'セッションエラーが発生しました';
      setLastError(message);
      setStatus('DISCONNECTED');
      if (hasConnectedOnceRef.current) {
        scheduleReconnect();
      }
    }
  }, [scheduleReconnect]);

  const connect = useCallback(
    async (params: ConnectParams) => {
      if (!params.sessionId && !params.clientTag) {
        setLastError('clientTag か sessionId を入力してください');
        return;
      }

      hasConnectedOnceRef.current = false;
      reconnectAttemptsRef.current = 0;

      let resolvedParams = params;
      if (!params.sessionId && params.clientTag) {
        try {
          resolvedParams = await resolveSessionIdByTag(params);
        } catch (error: any) {
          const message = String(error?.message ?? '');
          if (message === 'resolve_not_found') {
            setLastError('まだ該当タグのセッションがありません。再試行します…');
            setTimeout(() => {
              void connect(params);
            }, 1000);
            return;
          }
          if (message === 'resolve_unauthorized') {
            setLastError('BFF Key がありません（?bffKey= を付けるか NEXT_PUBLIC_BFF_KEY を設定してください）。');
            return;
          }
          setLastError('クライアントタグでセッションを解決できませんでした');
          return;
        }
      }

      disconnect();
      lastConnectParamsRef.current = params;
      setSessionId(resolvedParams.sessionId ?? null);
      setScenarioKey(resolvedParams.scenarioKey ?? resolvedParams.agentSetKey ?? null);
      setMemoryKey(resolvedParams.memoryKey ?? null);
      setActiveClientTag(params.clientTag ?? null);
      setStatus('CONNECTING');
      if (!params.preserveHistory) {
        setTranscripts([]);
        setDirectives([]);
        setEvents([]);
        setLastError(null);
      }

      const streamUrl = buildUrl(resolvedParams as Required<ConnectParams>);
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      const knownEvents = ['status', 'transport_event', 'voice_control', 'session_error', 'heartbeat', 'ready'];
      knownEvents.forEach((eventName) => {
        es.addEventListener(eventName, (event: MessageEvent<string>) => {
          const parsed = safeJsonParse(event.data);
          handleSseEvent(eventName, parsed);
        });
      });

      es.onopen = () => {
        hasConnectedOnceRef.current = true;
        reconnectAttemptsRef.current = 0;
        setStatus('CONNECTED');
      };
      es.onerror = async () => {
        setLastError('SSE接続でエラーが発生しました');
        disconnect();
        if (params.clientTag) {
          reconnectAttemptsRef.current += 1;
          scheduleReconnect();
        }
      };
    },
    [disconnect, handleSseEvent, resolveSessionIdByTag, scheduleReconnect],
  );

  useEffect(() => {
    connectRef.current = connect;
    return () => {
      connectRef.current = null;
    };
  }, [connect]);

  const resetMemory = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const params = lastConnectParamsRef.current;
    const agentSetKey = scenarioKey ?? undefined;
    if (!params || !agentSetKey) {
      const message = 'シナリオキーの解決後にリセットできます。';
      setLastError(message);
      return { ok: false, message };
    }
    const normalizedOrigin = buildOrigin(params.baseUrl);
    const url = new URL('/api/memory', normalizedOrigin);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (params.bffKey) {
      headers['x-bff-key'] = params.bffKey;
    }
    const body: Record<string, any> = { agentSetKey };
    if (memoryKey) {
      body.memoryKey = memoryKey;
    }
    if (params.clientTag) {
      body.clientTag = params.clientTag;
    }

    setIsResettingMemory(true);
    try {
      const response = await fetch(url.toString(), {
        method: 'DELETE',
        headers,
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        const message =
          'BFF Key がありません（?bffKey= を付けるか NEXT_PUBLIC_BFF_KEY を設定してください）。';
        setLastError(message);
        return { ok: false, message };
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message =
          (typeof payload?.message === 'string' && payload.message) ||
          '記憶リセットに失敗しました';
        setLastError(message);
        return { ok: false, message };
      }

      setTranscripts([]);
      setDirectives([]);
      setEvents([]);
      setLastError(null);
      // リセット後はクライアント側のメモリキーも破棄する
      setMemoryKey(null);
      if (params) {
        disconnect();
        await connect({ ...params, preserveHistory: false });
      }
      return { ok: true };
    } finally {
      setIsResettingMemory(false);
    }
  }, [connect, memoryKey, scenarioKey]);

  return useMemo(
    () => ({
      status,
      sessionId,
      activeClientTag,
      scenarioKey,
      memoryKey,
      transcripts,
      directives,
      events,
      lastError,
      connect,
      disconnect,
      resetMemory,
      isResettingMemory,
    }),
    [
      status,
      sessionId,
      activeClientTag,
      scenarioKey,
      memoryKey,
      transcripts,
      directives,
      events,
      lastError,
      connect,
      disconnect,
      resetMemory,
      isResettingMemory,
    ],
  );
}
