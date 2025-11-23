import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';

import type { RealtimeAgent } from '@openai/agents/realtime';
import OpenAI from 'openai';

import { createStructuredLogger } from '../../../framework/logging/structuredLogger';
import { createConsoleMetricEmitter } from '../../../framework/metrics/metricEmitter';
import type { MetricEmitter } from '../../../framework/metrics/metricEmitter';
import type { StructuredLogger } from '../../../framework/logging/structuredLogger';
import { createModerationGuardrail } from '../../../src/app/agentConfigs/guardrails';
import {
  agentSetMetadata,
  allAgentSets,
  scenarioMcpBindings,
  type ScenarioMcpBinding,
} from '../../../src/app/agentConfigs';
import { isRealtimeTranscriptionEventPayload } from '../../../src/shared/realtimeTranscriptionEvents';
import type { VoiceControlDirective, VoiceControlHandlers, ScenarioChangeOptions } from '../../../src/shared/voiceControl';
import type {
  ISessionManager,
  SessionEventName,
  SessionManagerHooks,
  SessionLifecycleStatus,
  IAgentSetResolver,
} from '../../realtime/types';
import { createOpenAIServerSessionManager } from '../../realtime/adapters/createOpenAIServerSessionManager';
import { McpEnabledAgentSetResolver } from '../../realtime/adapters/mcpEnabledAgentSetResolver';
import { loadMcpServersFromEnv } from '../../mcp/config';
import { McpServerRegistry } from '../../mcp/mcpServerRegistry';
import { getOrCreateTrace } from '@openai/agents-core';
import { OpenAIAgentSetResolver } from '../../realtime/adapters/openAIAgentSetResolver';
import { ServiceManager } from '../../../framework/di/ServiceManager';
import { HotwordListener, type HotwordMatch } from '../../../framework/voice_gateway/HotwordListener';
import { LlmScenarioNameClassifier } from '../../../framework/voice_gateway/LlmScenarioNameClassifier';
import { ScenarioRouter, type ScenarioCommandForwarder } from '../../scenario/ScenarioRouter';
import { ScenarioRegistry } from '../../scenario/ScenarioRegistry';
import { ServerHotwordCueService, type HotwordCueService } from './hotwordCueService';
import {
  buildReplayEvents,
  getPersistentMemoryStore,
  PERSISTENT_MEMORY_SOURCE,
  resolveMemoryKey,
  toMemoryEntry,
  type MemoryStore,
} from '../../coreData/persistentMemory';

const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_MAX_LIFETIME_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const STREAM_IDLE_CLEANUP_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 10;
// デフォルトでは永続メモリを無効化する（過去ログの大量再生でUIが汚染されるため）。
const PERSISTENT_MEMORY_ENABLED = process.env.PERSISTENT_MEMORY_ENABLED === 'true';
const PERSISTENT_MEMORY_REPLAY_LIMIT =
  Number(process.env.PERSISTENT_MEMORY_REPLAY_LIMIT ?? '') || 30;

const HOTWORD_TIMEOUT_MS = Number(process.env.HOTWORD_TIMEOUT_MS ?? '') || 8000;
const HOTWORD_REMINDER_DISCONNECT_DELAY_MS =
  Number(process.env.HOTWORD_REMINDER_DISCONNECT_DELAY_MS ?? '') || 2000;
const HOTWORD_REMINDER_TEXT =
  process.env.HOTWORD_REMINDER_TEXT ?? 'ホットワード「Hey + シナリオ名」で話しかけてください。';
const HOTWORD_REMINDER_ENABLED = (process.env.HOTWORD_REMINDER_ENABLED ?? 'false') === 'true';
const HOTWORD_REQUIRE_PREFIX = (process.env.HOTWORD_REQUIRE_PREFIX ?? 'false') === 'true';
const HOTWORD_LLM_ENABLED = (process.env.HOTWORD_LLM_ENABLED ?? 'true') === 'true';
const HOTWORD_LLM_MODEL = process.env.HOTWORD_LLM_MODEL ?? 'gpt-5-mini';
const HOTWORD_LLM_MIN_CONFIDENCE = Number(process.env.HOTWORD_LLM_MIN_CONFIDENCE ?? '0.6');
const HOTWORD_FUZZY_DISTANCE_THRESHOLD =
  Number(process.env.HOTWORD_FUZZY_DISTANCE_THRESHOLD ?? '2');
const HOTWORD_MIN_CONFIDENCE = Number(process.env.HOTWORD_MIN_CONFIDENCE ?? '0.6');
const HOTWORD_CUE_ENABLED = (process.env.HOTWORD_CUE_ENABLED ?? 'true') === 'true';
const DEEP_REASONING_TRIGGERS = ['深く考えて', 'じっくり', '丁寧に考えて', '理由を詳しく', 'ステップを教えて'];

function getCurrentTimeInTimeZone(timeZone: string): { currentTimeIso: string; timeZone: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);

  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const time = `${pick('hour')}:${pick('minute')}:${pick('second')}`;

  const tzName = pick('timeZoneName'); // e.g., "GMT+9" or "GMT+09:00"
  let offset = '+00:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (match) {
    const sign = match[1];
    const hours = match[2].padStart(2, '0');
    const minutes = (match[3] ?? '00').padStart(2, '0');
    offset = `${sign}${hours}:${minutes}`;
  }

  return { currentTimeIso: `${date}T${time}${offset}`, timeZone };
}

export type SessionCommand =
  | {
      kind: 'input_text';
      text: string;
      triggerResponse?: boolean;
      metadata?: Record<string, any>;
    }
  | {
      kind: 'input_audio';
      audio: string;
      commit?: boolean;
      response?: boolean;
    }
  | {
      kind: 'input_image';
      data: string;
      mimeType: string;
      encoding?: 'base64';
      text?: string;
      triggerResponse?: boolean;
    }
  | {
      kind: 'event';
      event: Record<string, any>;
    }
  | {
      kind: 'control';
      action: 'interrupt' | 'mute' | 'push_to_talk_start' | 'push_to_talk_stop';
      value?: boolean;
    };

export interface CreateSessionOptions {
  agentSetKey: string;
  preferredAgentName?: string;
  sessionLabel?: string;
  clientTag?: string;
  clientCapabilities?: {
    audio?: boolean;
    images?: boolean;
    outputText?: boolean;
  };
  metadata?: Record<string, any>;
  memoryKey?: string | null;
  memoryEnabled?: boolean;
}

export interface CreateSessionResult {
  sessionId: string;
  streamUrl: string;
  expiresAt: string;
  heartbeatIntervalMs: number;
  allowedModalities: Array<'text' | 'audio'>;
  textOutputEnabled: boolean;
  memoryKey: string | null;
  agentSet: {
    key: string;
    primary: string;
  };
  capabilityWarnings: string[];
}

export interface ResolveSessionResult {
  sessionId: string;
  streamUrl: string;
  expiresAt: string;
  status: SessionLifecycleStatus;
  agentSetKey: string;
  preferredAgentName?: string | null;
}

export interface ViewerSessionResult {
  clientTag: string;
  sessionId: string;
  streamUrl: string;
  scenarioKey: string | null;
  memoryKey: string | null;
  status: SessionLifecycleStatus;
}

export interface SessionStreamMessage {
  event: string;
  data: Record<string, any> | string | null;
  timestamp: string;
}

export interface RealtimeEnvironmentSnapshot {
  warnings: string[];
  audio: {
    enabled: boolean;
    reason?: string;
  };
}

interface SessionErrorSummary {
  code?: string;
  message?: string;
  type?: string;
  status?: number;
  retryable?: boolean;
  eventId?: string;
}

export class SessionHostError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'SessionHostError';
    this.code = code;
    this.status = status;
  }
}

interface SessionSubscriber {
  id: string;
  send: (message: SessionStreamMessage) => void;
}

interface SessionRateLimiter {
  hits: number[];
}

interface SessionContext {
  id: string;
  createdAt: number;
  expiresAt: number;
  maxLifetimeAt: number;
  status: SessionLifecycleStatus;
  connectedAt?: number;
  agentSetKey: string;
  preferredAgentName?: string;
  manager: ISessionManager<RealtimeAgent>;
  subscribers: Map<string, SessionSubscriber>;
  emitter: EventEmitter;
  destroy: (options?: DestroySessionOptions) => Promise<void>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  streamIdleTimer?: ReturnType<typeof setTimeout>;
  rateLimiter: SessionRateLimiter;
  lastCommandAt: number;
  allowedModalities: Array<'text' | 'audio'>;
  textOutputEnabled: boolean;
  memoryKey?: string | null;
  hasUserContent: boolean;
  hotwordListener?: HotwordListener;
  scenarioRouter?: ScenarioRouter;
  hotwordReminderTimer?: ReturnType<typeof setTimeout>;
  hotwordCuePlayedItems: Set<string>;
  clientTag?: string;
  destroyed?: boolean;
}

interface DestroySessionOptions {
  reason?: string;
  initiatedBy?: 'client' | 'server' | 'system';
}

interface ClientTagBinding {
  sessionId: string;
  scenarioKey: string | null;
  memoryKey: string | null;
  updatedAt: number;
  source: 'session' | 'manual';
}

interface SessionHostDeps {
  logger?: StructuredLogger;
  metrics?: MetricEmitter;
  now?: () => number;
  sessionManagerFactory?: (hooks: SessionManagerHooks) => ISessionManager<RealtimeAgent>;
  scenarioMap?: Record<string, RealtimeAgent[]>;
  envInspector?: () => RealtimeEnvironmentSnapshot;
  scenarioMcpBindings?: Record<string, ScenarioMcpBinding>;
  mcpRegistry?: McpServerRegistry;
  serviceManager?: ServiceManager;
  memoryStore?: MemoryStore;
  hotwordCueService?: HotwordCueService;
  hotwordCueAudioPath?: string;
  hotwordReminderEnabled?: boolean;
  hotwordReminderDisconnectDelayMs?: number;
  hotwordCueEnabled?: boolean;
}

export class SessionHost {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly clientTagIndex = new Map<string, ClientTagBinding>();
  private readonly logger: StructuredLogger;
  private readonly metrics: MetricEmitter;
  private readonly now: () => number;
  private readonly sessionManagerFactory: (hooks: SessionManagerHooks) => ISessionManager<RealtimeAgent>;
  private readonly scenarioMap: Record<string, RealtimeAgent[]>;
  private readonly scenarioMcpBindings: Record<string, ScenarioMcpBinding>;
  private readonly inspectEnvironment: () => RealtimeEnvironmentSnapshot;
  private readonly mcpRegistry?: McpServerRegistry;
  private readonly registryServiceManager?: ServiceManager;
  private readonly memoryStore: MemoryStore;
  private readonly scenarioRegistry: ScenarioRegistry;
  private readonly hotwordCueService: HotwordCueService;
  private readonly hotwordReminderEnabled: boolean;
  private readonly hotwordReminderDisconnectDelayMs: number;
  private readonly hotwordCueEnabled: boolean;

  constructor(deps: SessionHostDeps = {}) {
    this.logger = deps.logger ?? createStructuredLogger({ component: 'bff.session' });
    this.metrics = deps.metrics ?? createConsoleMetricEmitter('bff.session');
    this.now = deps.now ?? (() => Date.now());
    this.scenarioMap = deps.scenarioMap ?? allAgentSets;
    this.scenarioMcpBindings = deps.scenarioMcpBindings ?? scenarioMcpBindings;
    this.inspectEnvironment = deps.envInspector ?? (() => inspectRealtimeEnvironment());
    this.memoryStore = deps.memoryStore ?? getPersistentMemoryStore();

    this.hotwordCueService =
      deps.hotwordCueService ??
      new ServerHotwordCueService({
        audioFilePath: deps.hotwordCueAudioPath,
        logger: this.logger,
        metrics: this.metrics,
      });

    this.scenarioRegistry = new ScenarioRegistry({ scenarioMap: this.scenarioMap });
    this.hotwordReminderEnabled = deps.hotwordReminderEnabled ?? HOTWORD_REMINDER_ENABLED;
    this.hotwordReminderDisconnectDelayMs =
      deps.hotwordReminderDisconnectDelayMs ?? HOTWORD_REMINDER_DISCONNECT_DELAY_MS;
    this.hotwordCueEnabled = deps.hotwordCueEnabled ?? HOTWORD_CUE_ENABLED;

    const mcpConfigs = loadMcpServersFromEnv();
    const hasBindings = Object.values(this.scenarioMcpBindings).some(
      (binding) => binding.requiredMcpServers?.length > 0,
    );
    if (hasBindings && Object.keys(mcpConfigs).length > 0) {
      this.registryServiceManager = deps.serviceManager ?? new ServiceManager();
      this.mcpRegistry =
        deps.mcpRegistry ??
        new McpServerRegistry({
          configs: mcpConfigs,
          serviceManager: this.registryServiceManager,
          logger: this.logger,
        });
      this.eagerConnectMcpServers();
    }

    this.sessionManagerFactory =
      deps.sessionManagerFactory ??
      ((hooks) =>
        createOpenAIServerSessionManager({
          scenarioMap: this.scenarioMap,
          agentResolver: this.buildAgentResolver(),
          hooks,
        }));
  }

  private buildAgentResolver(): IAgentSetResolver<RealtimeAgent> {
    if (this.mcpRegistry) {
      return new McpEnabledAgentSetResolver({
        scenarios: this.scenarioMap,
        bindings: this.scenarioMcpBindings,
        registry: this.mcpRegistry,
        logger: this.logger,
      });
    }
    return new OpenAIAgentSetResolver(this.scenarioMap);
  }

  private createSessionHooks(
    sessionId: string,
    contextRef: { current: SessionContext | null },
  ): SessionManagerHooks {
    const sessionLogger = createStructuredLogger({
      component: 'bff.session',
      defaultContext: { sessionId },
    });
    const sessionMetrics = createConsoleMetricEmitter(`bff.session.${sessionId}`);
    return {
      logger: sessionLogger,
      metrics: sessionMetrics,
      onStatusChange: (status) => {
        if (contextRef.current) {
          contextRef.current.status = status;
          if (status === 'CONNECTED') {
            contextRef.current.connectedAt = this.now();
          }
        }
        this.broadcast(sessionId, 'status', { status });
      },
      // transport_event は onServerEvent 経由でのみ forward し、EventEmitter 側とは二重登録しない
      // （音声チャンクが二重再生されるのを防ぐため）。
      onServerEvent: (event, payload) => {
        let consumed = false;
        if (event === 'transport_event') {
          try {
            consumed = contextRef.current?.hotwordListener?.handleTranscriptionEvent(payload) ?? false;
          } catch (error) {
            this.logger.warn('Hotword listener failed to process event', {
              sessionId,
              error,
            });
          }
        }
        if (!consumed) {
          this.broadcast(sessionId, event, payload);
        }
      },
      guardrail: {
        onGuardrailTripped: (payload) =>
          this.broadcast(sessionId, 'guardrail_tripped', payload ?? {}),
      },
    };
  }

  async createSession(options: CreateSessionOptions): Promise<CreateSessionResult> {
    return getOrCreateTrace(() => this.createSessionImpl(options), {
      name: `session:create:${options.agentSetKey}`,
    });
  }

  resolveSessionByClientTag(clientTag: string): ResolveSessionResult {
    const binding = this.clientTagIndex.get(clientTag);
    const sessionId = binding?.sessionId;
    if (!sessionId) {
      this.logger.info('Resolve by clientTag not found', { clientTag });
      throw new SessionHostError('Session not found for clientTag', 'session_not_found', 404);
    }
    try {
      const context = this.ensureSession(sessionId);
      const scenarioKey = binding?.scenarioKey ?? context.agentSetKey ?? null;
      const memoryKey = binding?.memoryKey ?? context.memoryKey ?? null;
      this.clientTagIndex.set(clientTag, {
        sessionId,
        scenarioKey,
        memoryKey,
        updatedAt: this.now(),
        source: binding?.source ?? 'session',
      });
      this.logger.info('Resolve by clientTag hit', {
        clientTag,
        sessionId,
        agentSetKey: context.agentSetKey,
        preferredAgentName: context.preferredAgentName,
        status: context.status,
      });
      return {
        sessionId,
        streamUrl: `/api/session/${sessionId}/stream`,
        expiresAt: new Date(context.expiresAt).toISOString(),
        status: context.status,
        agentSetKey: context.agentSetKey,
        preferredAgentName: context.preferredAgentName ?? null,
      };
    } catch (error) {
      if (error instanceof SessionHostError) {
        if (['session_expired', 'session_not_found'].includes(error.code)) {
          const current = this.clientTagIndex.get(clientTag);
          if (current?.sessionId === sessionId) {
            this.clientTagIndex.delete(clientTag);
          }
          this.logger.info('Resolve found expired session, tag cleared', {
            clientTag,
            sessionId,
            code: error.code,
          });
        }
      }
      throw error;
    }
  }

  private saveClientTagBinding(clientTag: string, binding: Omit<ClientTagBinding, 'updatedAt'>): ClientTagBinding {
    const normalized: ClientTagBinding = {
      ...binding,
      scenarioKey: binding.scenarioKey ?? null,
      memoryKey: binding.memoryKey ?? null,
      updatedAt: this.now(),
    };
    this.clientTagIndex.set(clientTag, normalized);
    return normalized;
  }

  private toViewerSessionResult(
    clientTag: string,
    context: SessionContext,
    binding?: ClientTagBinding,
    source: ClientTagBinding['source'] = 'session',
  ): ViewerSessionResult {
    const stored = this.saveClientTagBinding(clientTag, {
      sessionId: context.id,
      scenarioKey: binding?.scenarioKey ?? context.agentSetKey ?? null,
      memoryKey: binding?.memoryKey ?? context.memoryKey ?? null,
      source,
    });
    return {
      clientTag,
      sessionId: context.id,
      streamUrl: `/api/session/${context.id}/stream`,
      scenarioKey: stored.scenarioKey,
      memoryKey: stored.memoryKey,
      status: context.status,
    };
  }

  registerViewerSession(clientTag: string, sessionId: string, scenarioKey?: string | null): ViewerSessionResult {
    const context = this.ensureSession(sessionId);
    this.logger.info('Viewer register override', { clientTag, sessionId, scenarioKey });
    const binding: ClientTagBinding = {
      sessionId,
      scenarioKey: scenarioKey ?? context.agentSetKey ?? null,
      memoryKey: context.memoryKey ?? null,
      updatedAt: this.now(),
      source: 'manual',
    };
    this.clientTagIndex.set(clientTag, binding);
    return this.toViewerSessionResult(clientTag, context, binding, 'manual');
  }

  resolveViewerSession(clientTag: string): ViewerSessionResult {
    const binding = this.clientTagIndex.get(clientTag);
    const sessionId = binding?.sessionId;
    if (!sessionId) {
      this.logger.info('Viewer resolve not found', { clientTag });
      throw new SessionHostError('Session not found for clientTag', 'session_not_found', 404);
    }
    try {
      const context = this.ensureSession(sessionId);
      const result = this.toViewerSessionResult(clientTag, context, binding, binding?.source ?? 'session');
      this.logger.info('Viewer resolve hit', {
        clientTag,
        sessionId,
        scenarioKey: result.scenarioKey,
        status: result.status,
      });
      return result;
    } catch (error) {
      if (error instanceof SessionHostError) {
        if (['session_expired', 'session_not_found'].includes(error.code)) {
          const current = this.clientTagIndex.get(clientTag);
          if (current?.sessionId === sessionId) {
            this.clientTagIndex.delete(clientTag);
          }
          this.logger.info('Viewer resolve found expired session, tag cleared', {
            clientTag,
            sessionId,
            code: error.code,
          });
        }
      }
      throw error;
    }
  }

  /**
   * Optional eager MCP接続。環境変数 MCP_EAGER_SERVERS="google-calendar,foo"
   * のように指定すると、BFF起動時にバックグラウンドで connect を開始する。
   * 失敗しても起動を止めず、ログのみ出す。
   */
  private eagerConnectMcpServers() {
    const list = (process.env.MCP_EAGER_SERVERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!this.mcpRegistry || list.length === 0) return;

    // fire-and-forget
    Promise.all(list.map((id) => this.mcpRegistry!.ensureServer(id)))
      .then(() => {
        this.logger.info('Eager MCP connect completed', { servers: list });
        this.metrics.increment('bff.session.mcp_eager_success_total', 1, { servers: list.join(',') });
      })
      .catch((error) => {
        this.logger.warn('Eager MCP connect failed (non-fatal)', { servers: list, error });
        this.metrics.increment('bff.session.mcp_eager_failure_total', 1, { servers: list.join(',') });
      });
  }

  private async createSessionImpl(options: CreateSessionOptions): Promise<CreateSessionResult> {
    const agentSet = this.scenarioMap[options.agentSetKey];
    if (!agentSet) {
      throw new SessionHostError('Unknown agentSetKey', 'invalid_agent_set', 400);
    }

    const sessionId = this.generateSessionId();
    const contextRef: { current: SessionContext | null } = { current: null };
    const hooks = this.createSessionHooks(sessionId, contextRef);

    const companyName = agentSetMetadata[options.agentSetKey]?.companyName ?? 'DefaultCo';
    const guardrail = createModerationGuardrail(companyName);
    const envSnapshot = this.inspectEnvironment();
    const textOutputEnabled = options.clientCapabilities?.outputText !== false;
    const resolvedModalities = this.resolveRuntimeModalities(options, envSnapshot, textOutputEnabled);
    const reportedModalities = this.buildReportedModalities(options, envSnapshot, textOutputEnabled);
    const memoryEnabled = options.memoryEnabled ?? PERSISTENT_MEMORY_ENABLED;
    const memoryKey = memoryEnabled
      ? resolveMemoryKey(options.agentSetKey, options.memoryKey, options.metadata)
      : null;

    const manager = this.sessionManagerFactory(hooks);
    const context = this.buildSessionContext({
      sessionId,
      options,
      reportedModalities,
      textOutputEnabled,
      manager,
      memoryKey,
    });
    contextRef.current = context;

    this.sessions.set(sessionId, context);
    if (options.clientTag) {
      this.clientTagIndex.set(options.clientTag, {
        sessionId,
        scenarioKey: options.agentSetKey ?? null,
        memoryKey,
        updatedAt: this.now(),
        source: 'session',
      });
      this.logger.info('Session created', {
        sessionId,
        clientTag: options.clientTag,
        agentSetKey: options.agentSetKey,
        preferredAgentName: options.preferredAgentName,
        reportedModalities,
        textOutputEnabled,
      });
    }
    const voiceControlHandlers = this.createVoiceControlHandlers(sessionId, context);

    const scenarioRouter = new ScenarioRouter({
      currentScenarioKey: options.agentSetKey,
      voiceControl: voiceControlHandlers,
      forwarder: this.buildScenarioCommandForwarder(context),
      logger: this.logger,
    });
    const llmClassifier = HOTWORD_LLM_ENABLED
      ? new LlmScenarioNameClassifier({
          model: HOTWORD_LLM_MODEL,
          minimumConfidence: HOTWORD_LLM_MIN_CONFIDENCE,
          logger: this.logger,
        })
      : undefined;
    if (llmClassifier) {
      this.logger.info('Hotword LLM classifier enabled', {
        model: HOTWORD_LLM_MODEL,
        minConfidence: HOTWORD_LLM_MIN_CONFIDENCE,
      });
    }

    const hotwordListener = new HotwordListener({
      dictionary: this.scenarioRegistry.getHotwordDictionary(),
      reminderTimeoutMs: HOTWORD_REMINDER_ENABLED ? HOTWORD_TIMEOUT_MS : Number.MAX_SAFE_INTEGER,
      requirePrefix: HOTWORD_REQUIRE_PREFIX,
      minimumLlmConfidence: HOTWORD_LLM_MIN_CONFIDENCE,
      minimumConfidence: HOTWORD_MIN_CONFIDENCE,
      fuzzyDistanceThreshold: HOTWORD_FUZZY_DISTANCE_THRESHOLD,
      llmClassifier,
      onDetection: async (detection) => {
        this.logger.debug('Hotword prefix detected', {
          sessionId,
          scenarioKey: detection.scenarioKey,
          stage: detection.stage,
          method: detection.method,
          confidence: detection.confidence,
        });
        await this.emitHotwordCue(context, {
          scenarioKey: detection.scenarioKey,
          transcript: detection.transcript,
          itemId: detection.itemId,
        });
      },
      onMatch: async (match) => {
        this.logger.info('Hotword matched', {
          sessionId,
          scenarioKey: match.scenarioKey,
          commandPreview: match.commandText.slice(0, 60),
          method: match.method,
          confidence: match.confidence,
        });
        await this.emitHotwordCue(context, {
          scenarioKey: match.scenarioKey,
          transcript: match.transcript,
          itemId: match.itemId,
        });
        await scenarioRouter.handleHotwordMatch(match);
      },
      onInvalidTranscript: ({ itemId, transcript }) => {
        this.logger.debug('Hotword miss; deleting transcript item', {
          sessionId,
          itemId,
          transcriptPreview: String(transcript ?? '').slice(0, 60),
        });
        this.deleteTranscriptItem(context, itemId);
      },
      onTimeout: () => this.handleHotwordTimeout(context),
    });
    context.scenarioRouter = scenarioRouter;
    context.hotwordListener = hotwordListener;

    if (options.clientCapabilities?.audio !== false && !envSnapshot.audio.enabled) {
      this.logger.warn('Audio requested but disabled. Falling back to text-only session.', {
        sessionId,
        reason: envSnapshot.audio.reason,
      });
    }

    if (envSnapshot.warnings.length > 0) {
      this.logger.warn('Realtime environment warnings detected', {
        sessionId,
        warnings: envSnapshot.warnings,
      });
    }

    const { currentTimeIso, timeZone } = getCurrentTimeInTimeZone('Asia/Tokyo');

    await manager.connect({
      agentSetKey: options.agentSetKey,
      preferredAgentName: options.preferredAgentName,
      getEphemeralKey: async () => this.getRealtimeApiKey(),
      extraContext: {
        sessionLabel: options.sessionLabel,
        metadata: options.metadata ?? {},
        clientCapabilities: options.clientCapabilities ?? {},
        requestScenarioChange: voiceControlHandlers.requestScenarioChange,
        requestAgentChange: voiceControlHandlers.requestAgentChange,
        persistentMemoryKey: memoryKey ?? undefined,
        currentTimeIso,
        timeZone,
      },
      outputGuardrails: [guardrail],
      outputModalities: resolvedModalities,
    });

    if (memoryKey) {
      await this.rehydratePersistentMemory(context);
    }

    this.attachManagerListeners(context);
    this.startHeartbeat(context);
    this.broadcast(sessionId, 'status', { status: 'CONNECTED' });
    // クライアント側の onReady フックが初期コマンド送信をトリガーするため、確実に ready を通知する
    this.broadcast(sessionId, 'ready', {
      sessionId,
      agentSetKey: options.agentSetKey,
      preferredAgentName: options.preferredAgentName ?? null,
    });
    this.metrics.increment('bff.session.created_total');

    return {
      sessionId,
      streamUrl: `/api/session/${sessionId}/stream`,
      expiresAt: new Date(context.expiresAt).toISOString(),
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      allowedModalities: reportedModalities,
      textOutputEnabled,
      memoryKey,
      capabilityWarnings: envSnapshot.warnings,
      agentSet: {
        key: options.agentSetKey,
        primary: agentSet[0]?.name ?? 'agent',
      },
    };
  }

  private buildSessionContext(params: {
    sessionId: string;
    options: CreateSessionOptions;
    reportedModalities: Array<'text' | 'audio'>;
    textOutputEnabled: boolean;
    manager: ISessionManager<RealtimeAgent>;
    memoryKey: string | null;
  }): SessionContext {
    const { sessionId, options, reportedModalities, textOutputEnabled, manager, memoryKey } = params;
    const now = this.now();
    const context: SessionContext = {
      id: sessionId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      maxLifetimeAt: now + SESSION_MAX_LIFETIME_MS,
      status: 'DISCONNECTED',
      destroyed: false,
      agentSetKey: options.agentSetKey,
      preferredAgentName: options.preferredAgentName,
      manager,
      subscribers: new Map(),
      emitter: new EventEmitter(),
      hotwordCuePlayedItems: new Set(),
      destroy: async (destroyOptions: DestroySessionOptions = {}) => {
        if (context.destroyed) {
          return;
        }
        context.destroyed = true;
        const reason = destroyOptions.reason ?? 'unspecified';
        const initiatedBy = destroyOptions.initiatedBy ?? 'system';

        // 通知を先に飛ばすことで、SSE購読側がセッション切断を検知して再接続できるようにする。
        this.broadcast(sessionId, 'session_error', {
          code: destroyOptions.reason ?? 'session_terminated',
          message: `Session terminated: ${reason}`,
          initiatedBy,
        });
        this.broadcast(sessionId, 'status', { status: 'DISCONNECTED' });

        this.clearTimers(context);
        this.sessions.delete(sessionId);
        if (context.clientTag) {
          const binding = this.clientTagIndex.get(context.clientTag);
          if (binding?.sessionId === sessionId) {
            this.clientTagIndex.delete(context.clientTag);
          }
        }
        try {
          manager.disconnect();
        } catch (error) {
          this.logger.warn('Failed to disconnect session cleanly', { sessionId, error });
        }
        this.logger.info('Session destroyed', { sessionId, reason, initiatedBy });
        this.metrics.increment('bff.session.closed_total', 1, {
          initiatedBy,
          reason,
        });
      },
      rateLimiter: { hits: [] },
      lastCommandAt: now,
      allowedModalities: reportedModalities,
      textOutputEnabled,
      memoryKey,
      hasUserContent: false,
      clientTag: options.clientTag,
    };
    return context;
  }

  private buildScenarioCommandForwarder(context: SessionContext): ScenarioCommandForwarder {
    return {
      replaceTranscriptWithText: async (match) => {
        if (match.itemId) {
          this.deleteTranscriptItem(context, match.itemId);
        }
        this.sendUserTextCommand(context, match.commandText);
      },
      interruptActiveResponse: async () => {
        try {
          context.manager.interrupt();
        } catch (error) {
          this.logger.warn('Failed to interrupt active response during scenario switch', {
            sessionId: context.id,
            error,
          });
        }
      },
    };
  }

  async destroySession(sessionId: string, options: DestroySessionOptions = {}): Promise<boolean> {
    const context = this.sessions.get(sessionId);
    if (!context) {
      return false;
    }
    await context.destroy(options);
    return true;
  }

  ensureSession(sessionId: string): SessionContext {
    const context = this.sessions.get(sessionId);
    if (!context) {
      throw new SessionHostError('Session not found', 'session_not_found', 404);
    }

    const now = this.now();
    if (now > context.maxLifetimeAt) {
      void context.destroy({ reason: 'max_lifetime_exceeded', initiatedBy: 'system' });
      throw new SessionHostError('Session lifetime exceeded', 'session_expired', 410);
    }

    if (now > context.expiresAt) {
      void context.destroy({ reason: 'session_ttl_expired', initiatedBy: 'system' });
      throw new SessionHostError('Session expired', 'session_expired', 410);
    }

    return context;
  }

  async handleCommand(sessionId: string, command: SessionCommand): Promise<SessionLifecycleStatus> {
    const context = this.ensureSession(sessionId);
    this.enforceRateLimit(context);
    context.expiresAt = this.now() + SESSION_TTL_MS;
    context.lastCommandAt = this.now();

    switch (command.kind) {
      case 'input_text':
        this.handleInputText(context, command);
        break;
      case 'input_audio':
        this.handleInputAudio(context, command);
        break;
      case 'input_image':
        this.handleInputImage(context, command);
        break;
      case 'event':
        this.handleRawEvent(context, command);
        break;
      case 'control':
        this.handleControlCommand(context, command);
        break;
      default:
        throw new SessionHostError('Unsupported command', 'invalid_event_payload', 400);
    }

    return context.manager.getStatus();
  }

  private deleteTranscriptItem(context: SessionContext, itemId?: string) {
    if (!itemId) return;
    try {
      context.manager.sendEvent({ type: 'conversation.item.delete', item_id: itemId });
    } catch (error) {
      this.logger.warn('Failed to delete conversation item', {
        sessionId: context.id,
        itemId,
        error,
      });
    }
  }

  private sendUserTextCommand(
    context: SessionContext,
    text: string,
    metadata?: Record<string, any>,
  ) {
    if (!text || text.trim().length === 0) return;
    context.hasUserContent = true;
    if (metadata && Object.keys(metadata).length > 0) {
      this.logger.debug('Dropping response metadata to satisfy Realtime API schema', {
        sessionId: context.id,
        metadata,
      });
    }
    try {
      context.manager.sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text,
            },
          ],
        },
      });
      context.manager.sendEvent({ type: 'response.create' });
      this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'input_text' });
    } catch (error) {
      this.logger.error('Failed to forward user text to realtime manager', {
        sessionId: context.id,
        error,
      });
      throw new SessionHostError('Failed to forward text event', 'event_dispatch_failed', 500);
    }
  }

  private handleInputText(context: SessionContext, command: Extract<SessionCommand, { kind: 'input_text' }>) {
    const text = command.text ?? '';
    if (this.shouldForceDeepReasoning(text)) {
      this.logger.info('Deep reasoning trigger detected; executing responses API fallback', {
        sessionId: context.id,
      });
      this.runDeepReasoningFallback(context, text).catch((error) => {
        this.logger.error('Deep reasoning fallback failed; forwarding to realtime as usual', {
          sessionId: context.id,
          error,
        });
        this.sendUserTextCommand(context, text, command.metadata);
      });
      return;
    }

    this.sendUserTextCommand(context, text, command.metadata);
  }

  private shouldForceDeepReasoning(text: string): boolean {
    const normalized = text ?? '';
    return DEEP_REASONING_TRIGGERS.some((kw) => normalized.includes(kw));
  }

  private async runDeepReasoningFallback(context: SessionContext, question: string): Promise<void> {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const body = {
      model: 'gpt-5.1',
      reasoning: { effort: 'high' },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text' as const,
              text: `日本語で丁寧かつ簡潔に回答してください。必ず結論→理由→具体アクションの順で3〜5文。質問: ${question}`,
            },
          ],
        },
      ],
      max_output_tokens: 600,
    };

    const response = await openai.responses.create(body as any);
    const outputItems: any[] = Array.isArray((response as any).output) ? (response as any).output : [];
    const text = outputItems
      .flatMap((item: any) => item?.content ?? [])
      .filter((c: any) => c?.type === 'output_text')
      .map((c: any) => c.text)
      .join('\n');

    const assistantText = text || '詳細回答を取得できませんでした。';

    // Realtimeに再生成させ、音声で返すためにユーザー発話と補助システム指示として注入する
    context.manager.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: question,
          },
        ],
      },
    });

    context.manager.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text:
              '深く考えた推論結果が以下にある。内容を崩さず日本語で2〜4文に要約し、音声で返答しなさい。結論→理由→具体アクションの順で簡潔に。\n\n推論結果:\n' +
              assistantText,
          },
        ],
      },
    });

    context.manager.sendEvent({ type: 'response.create' });

    this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'deep_reasoning_fallback' });
  }

  private handleInputAudio(context: SessionContext, command: Extract<SessionCommand, { kind: 'input_audio' }>) {
    context.hasUserContent = true;
    context.manager.sendEvent({
      type: 'input_audio_buffer.append',
      audio: command.audio,
    });
    if (command.commit !== false) {
      context.manager.sendEvent({ type: 'input_audio_buffer.commit' });
    }
    this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'input_audio' });
  }

  private handleInputImage(context: SessionContext, command: Extract<SessionCommand, { kind: 'input_image' }>) {
    context.hasUserContent = true;
    const imageUrl =
      command.mimeType && command.data && command.data.startsWith('data:')
        ? command.data
        : `data:${command.mimeType ?? 'image/png'};base64,${command.data}`;
    context.manager.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: command.text ?? '[Image uploaded]',
          },
          {
            type: 'input_image',
            image_url: imageUrl,
          },
        ],
      },
    });
    if (command.triggerResponse !== false) {
      context.manager.sendEvent({ type: 'response.create' });
    }
    this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'input_image' });
  }

  private handleHotwordTimeout(context: SessionContext) {
    if (!this.hotwordReminderEnabled) {
      return;
    }
    if (context.hotwordReminderTimer) {
      return;
    }
    this.logger.info('Hotword timeout reached; issuing reminder', { sessionId: context.id });
    this.sendHotwordReminder(context);
    context.hotwordReminderTimer = setTimeout(() => {
      if (context.hotwordReminderTimer) {
        clearTimeout(context.hotwordReminderTimer);
        context.hotwordReminderTimer = undefined;
      }
      this.destroySession(context.id, { reason: 'hotword_timeout', initiatedBy: 'system' }).catch((error) => {
        this.logger.warn('Failed to destroy session after hotword timeout', { sessionId: context.id, error });
      });
    }, this.hotwordReminderDisconnectDelayMs);
  }

  private async emitHotwordCue(
    context: SessionContext,
    payload: { scenarioKey: string; transcript: string; itemId?: string },
  ): Promise<void> {
    if (payload.itemId && context.hotwordCuePlayedItems.has(payload.itemId)) {
      return;
    }
    if (!this.hotwordCueEnabled) {
      this.logger.debug('Hotword cue suppressed (disabled via config)', {
        sessionId: context.id,
        scenarioKey: payload.scenarioKey,
      });
      if (payload.itemId) {
        context.hotwordCuePlayedItems.add(payload.itemId);
      }
      return;
    }
    const cueResult = await this.hotwordCueService.playCue({
      sessionId: context.id,
      scenarioKey: payload.scenarioKey,
      transcript: payload.transcript,
    });
    if (payload.itemId) {
      context.hotwordCuePlayedItems.add(payload.itemId);
    }
    this.broadcast(context.id, 'hotword_cue', {
      cueId: cueResult.cueId,
      scenarioKey: payload.scenarioKey,
      status: cueResult.status,
      reason: cueResult.reason,
      audio: cueResult.audio,
    });
  }

  private sendHotwordReminder(context: SessionContext) {
    try {
      context.manager.interrupt();
    } catch (error) {
      this.logger.debug('Interrupt failed during hotword reminder', { sessionId: context.id, error });
    }
    const reminderPrompt = `システム通知: ユーザーがホットワードなしで話しました。次の回答では「${HOTWORD_REMINDER_TEXT}」と丁寧に伝えてください。`;
    context.manager.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: reminderPrompt,
          },
        ],
      },
    });
    context.manager.sendEvent({ type: 'response.create' });
  }

  private handleRawEvent(context: SessionContext, command: Extract<SessionCommand, { kind: 'event' }>) {
    if (command.event?.type === 'response.create' && !context.hasUserContent) {
      // ユーザー入力（またはメモリ再生）が無い初回の自動応答は抑制する（全シナリオ共通）。
      this.logger.debug('response.create ignored because no user content yet', { sessionId: context.id });
      return;
    }
    if (command.event?.type === 'conversation.item.create' && command.event?.item?.role === 'assistant') {
      // 念のため、サーバ側でassistant messageを直接流す要求は拒否する。
      this.logger.debug('assistant conversation item blocked', { sessionId: context.id });
      return;
    }
    context.manager.sendEvent(command.event);
    this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'raw_event' });
  }

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const context = this.ensureSession(sessionId);
    context.subscribers.set(subscriber.id, subscriber);
    context.emitter.on('message', subscriber.send);

    if (context.streamIdleTimer) {
      clearTimeout(context.streamIdleTimer);
      context.streamIdleTimer = undefined;
    }

    // 直近の状態を即時送信
    subscriber.send({
      event: 'status',
      data: { status: context.manager.getStatus() },
      timestamp: new Date(this.now()).toISOString(),
    });

    return () => {
      context.subscribers.delete(subscriber.id);
      context.emitter.off('message', subscriber.send);
      if (context.subscribers.size === 0) {
        context.streamIdleTimer = setTimeout(() => {
          this.destroySession(sessionId, {
            reason: 'sse_idle_timeout',
            initiatedBy: 'system',
          }).catch((error) =>
            this.logger.error('Failed to cleanup idle session', { sessionId, error }),
          );
        }, STREAM_IDLE_CLEANUP_MS);
      }
    };
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  private handleControlCommand(context: SessionContext, command: Extract<SessionCommand, { kind: 'control' }>) {
    switch (command.action) {
      case 'interrupt':
        context.manager.interrupt();
        break;
      case 'mute':
        context.manager.mute(Boolean(command.value));
        break;
      case 'push_to_talk_start':
        context.manager.pushToTalkStart();
        break;
      case 'push_to_talk_stop':
        context.manager.pushToTalkStop();
        break;
      default:
        throw new SessionHostError('Unknown control action', 'invalid_event_payload', 400);
    }
  }

  private resolveRuntimeModalities(
    options: CreateSessionOptions,
    snapshot: RealtimeEnvironmentSnapshot,
    textOutputEnabled: boolean,
  ): Array<'text' | 'audio'> {
    const audioRequested = options.clientCapabilities?.audio !== false;
    const audioAvailable = audioRequested && snapshot.audio.enabled;

    if (!audioRequested && !textOutputEnabled) {
      throw new SessionHostError(
        'Client must enable audio or text output when creating a session',
        'invalid_client_capabilities',
        400,
      );
    }

    if (audioAvailable) {
      return ['audio'];
    }

    if (textOutputEnabled) {
      return ['text'];
    }

    throw new SessionHostError(
      'Audio output unavailable in current environment and text output disabled by client',
      'invalid_client_capabilities',
      400,
    );
  }

  private buildReportedModalities(
    options: CreateSessionOptions,
    snapshot: RealtimeEnvironmentSnapshot,
    textOutputEnabled: boolean,
  ): Array<'text' | 'audio'> {
    const modalities: Array<'text' | 'audio'> = [];
    const audioRequested = options.clientCapabilities?.audio !== false;
    if (audioRequested && snapshot.audio.enabled) {
      modalities.push('audio');
    }
    if (textOutputEnabled) {
      modalities.push('text');
    }
    if (modalities.length === 0) {
      // fallback for text-only environments
      modalities.push('text');
    }
    return modalities;
  }

  private normalizeRealtimeError(payload: any): SessionErrorSummary {
    const pickString = (value: unknown) =>
      typeof value === 'string' && value.length > 0 ? value : undefined;

    if (!payload || typeof payload !== 'object') {
      return {
        message: pickString(payload as string) ?? 'Unknown Realtime error',
      };
    }

    const source = typeof payload.error === 'object' && payload.error ? payload.error : payload;
    const nestedErrorCandidate = Array.isArray((source as any).errors)
      ? (source as any).errors[0]
      : undefined;
    const leaf =
      typeof (source as any).error === 'object' && (source as any).error
        ? (source as any).error
        : nestedErrorCandidate ?? source;

    const summary: SessionErrorSummary = {
      code: pickString((leaf as any).code) ?? pickString((source as any).code),
      message:
        pickString((leaf as any).message) ??
        pickString((source as any).message) ??
        pickString((payload as any).message),
      type: pickString((leaf as any).type) ?? pickString((source as any).type),
      eventId: pickString((source as any).event_id ?? (source as any).eventId),
    };

    if (typeof (leaf as any).status === 'number') {
      summary.status = (leaf as any).status;
    } else if (typeof (source as any).status === 'number') {
      summary.status = (source as any).status;
    }

    if (typeof (leaf as any).retryable === 'boolean') {
      summary.retryable = (leaf as any).retryable;
    } else if (typeof (source as any).retryable === 'boolean') {
      summary.retryable = (source as any).retryable;
    }

    if (!summary.message && typeof payload === 'string') {
      summary.message = payload;
    }

    if (!summary.message) {
      summary.message = 'Unknown Realtime error';
    }

    return summary;
  }

  private sanitizeErrorPayload(payload: any) {
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return undefined;
    }
  }

  private enforceRateLimit(context: SessionContext) {
    const now = this.now();
    context.rateLimiter.hits = context.rateLimiter.hits.filter(
      (ts) => now - ts < RATE_LIMIT_WINDOW_MS,
    );
    if (context.rateLimiter.hits.length >= RATE_LIMIT_MAX_EVENTS) {
      throw new SessionHostError('Too many events', 'rate_limit_exceeded', 429);
    }
    context.rateLimiter.hits.push(now);
  }

  private attachManagerListeners(context: SessionContext) {
    const forwardableEvents: SessionEventName[] = [
      'agent_handoff',
      'agent_tool_start',
      'agent_tool_end',
      'history_updated',
      'history_added',
      'guardrail_tripped',
      'error',
    ];

    forwardableEvents.forEach((event) => {
      const handler = (...args: any[]) => {
        const payload = args.length > 1 ? args : args[0];
        let forwardPayload = payload;

        if (event === 'history_added' || event === 'history_updated') {
          const filtered = this.normalizeHistoryPayload(payload).filter(
            (item) => !this.isPersistentMemoryReplay(item),
          );

          if (filtered.length === 0) {
            return;
          }

          forwardPayload = Array.isArray(payload) ? filtered : filtered[0];
          void this.persistMemoryFromHistory(context, forwardPayload);
        }

        this.broadcast(context.id, event, forwardPayload);
        if (event === 'error') {
          const summary = this.normalizeRealtimeError(payload);
          const rawPayload = this.sanitizeErrorPayload(payload);
          this.logger.error('Realtime session error', {
            sessionId: context.id,
            ...summary,
            raw: rawPayload,
          });
          this.metrics.increment('bff.session.realtime_errors_total', 1, {
            code: summary.code ?? 'unknown',
          });
          this.broadcast(context.id, 'session_error', summary);
        }
      };
      context.manager.on(event, handler as any);
      context.emitter.once('cleanup', () => context.manager.off(event, handler as any));
    });
  }

  private async rehydratePersistentMemory(context: SessionContext): Promise<void> {
    if (!context.memoryKey) return;
    try {
      const entries = await this.memoryStore.read(context.memoryKey, PERSISTENT_MEMORY_REPLAY_LIMIT);
      if (entries.length === 0) return;
      context.hasUserContent = true;
      const events = buildReplayEvents(entries, PERSISTENT_MEMORY_REPLAY_LIMIT);
      events.forEach((ev) => {
        try {
          context.manager.sendEvent(ev);
        } catch (error) {
          this.logger.warn('Failed to send replay event', {
            sessionId: context.id,
            error,
          });
        }
      });
      this.logger.info('Persistent memory replayed', {
        sessionId: context.id,
        memoryKey: context.memoryKey,
        count: events.length,
      });
    } catch (error) {
      this.logger.warn('Failed to replay persistent memory', {
        sessionId: context.id,
        memoryKey: context.memoryKey,
        error,
      });
    }
  }

  private async persistMemoryFromHistory(context: SessionContext, payload: any): Promise<void> {
    if (!context.memoryKey) return;
    const items = Array.isArray(payload) ? payload : [payload];
    const now = this.now();
    const entries = items
      .map((item) => toMemoryEntry(item, now))
      .filter((entry): entry is NonNullable<ReturnType<typeof toMemoryEntry>> => Boolean(entry));

    if (entries.length === 0) return;

    await Promise.all(
      entries.map((entry) =>
        this.memoryStore.upsert(context.memoryKey!, entry).catch((error) => {
          this.logger.warn('Failed to persist memory entry', {
            sessionId: context.id,
            memoryKey: context.memoryKey,
            error,
          });
          this.broadcast(context.id, 'session_error', {
            code: 'memory_persist_failed',
            message: 'Failed to persist memory entry',
          });
          this.metrics.increment('bff.session.memory_persist_failed_total', 1);
        }),
      ),
    );
  }

  private isPersistentMemoryReplay(payload: any): boolean {
    return payload?.metadata?.source === PERSISTENT_MEMORY_SOURCE;
  }

  private normalizeHistoryPayload(payload: any): any[] {
    if (Array.isArray(payload)) return payload;
    return payload ? [payload] : [];
  }

  private startHeartbeat(context: SessionContext) {
    context.heartbeatTimer = setInterval(() => {
      this.broadcast(context.id, 'heartbeat', { ts: Date.now() });
      const now = this.now();
      if (now - context.lastCommandAt > SESSION_TTL_MS) {
        this.destroySession(context.id, {
          reason: 'heartbeat_timeout',
          initiatedBy: 'system',
        }).catch((error) =>
          this.logger.error('Failed to cleanup inactive session', { sessionId: context.id, error }),
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private broadcast(sessionId: string, event: string, data: Record<string, any> | string | null) {
    const context = this.sessions.get(sessionId);
    if (!context) return;
    if (event === 'transport_event' && !context.textOutputEnabled && isRealtimeTranscriptionEventPayload(data)) {
      return;
    }
    const message: SessionStreamMessage = {
      event,
      data,
      timestamp: new Date(this.now()).toISOString(),
    };
    context.emitter.emit('message', message);
  }

  private clearTimers(context: SessionContext) {
    if (context.heartbeatTimer) {
      clearInterval(context.heartbeatTimer);
      context.heartbeatTimer = undefined;
    }
    if (context.streamIdleTimer) {
      clearTimeout(context.streamIdleTimer);
      context.streamIdleTimer = undefined;
    }
    if (context.hotwordReminderTimer) {
      clearTimeout(context.hotwordReminderTimer);
      context.hotwordReminderTimer = undefined;
    }
    context.emitter.emit('cleanup');
    context.emitter.removeAllListeners();
  }

  private generateSessionId(): string {
    return `sess_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  private createVoiceControlHandlers(sessionId: string, context: SessionContext): VoiceControlHandlers {
    const emitDirective = (directive: VoiceControlDirective) => {
      this.broadcast(sessionId, 'voice_control', directive);
    };

    return {
      requestScenarioChange: async (scenarioKey: string, options?: ScenarioChangeOptions) => {
        if (!scenarioKey) {
          return { success: false, message: '有効なシナリオキーを指定してください。' };
        }
        emitDirective({ action: 'switchScenario', scenarioKey, initialCommand: options?.initialCommand });
        return { success: true, message: `シナリオ「${scenarioKey}」へ切り替えます。` };
      },
      requestAgentChange: async (agentName: string) => {
        if (!agentName) {
          return { success: false, message: '有効なエージェント名を指定してください。' };
        }
        emitDirective({ action: 'switchAgent', agentName });
        return { success: true, message: `エージェント「${agentName}」に切り替えます。` };
      },
    };
  }

  private getRealtimeApiKey(): string {
    const apiKey =
      process.env.OPENAI_API_KEY ?? process.env.OPENAI_REALTIME_API_KEY ?? process.env.OPENAI_API_KEY_VOICE;
    if (!apiKey) {
      throw new SessionHostError('Realtime API key is not configured', 'missing_api_key', 500);
    }
    return apiKey;
  }
}

const SESSION_HOST_SYMBOL = Symbol.for('mcpc.sessionHost.singleton');

export function getSessionHost(): SessionHost {
  const globalScope = globalThis as typeof globalThis & {
    [SESSION_HOST_SYMBOL]?: SessionHost;
  };

  if (!globalScope[SESSION_HOST_SYMBOL]) {
    globalScope[SESSION_HOST_SYMBOL] = new SessionHost();
  }

  return globalScope[SESSION_HOST_SYMBOL]!;
}

export const sessionHost = getSessionHost();

const AUDIO_REQUIREMENT_KEYS = [
  'OPENAI_REALTIME_MODEL',
  'OPENAI_REALTIME_TRANSCRIPTION_MODEL',
  'OPENAI_REALTIME_VOICE',
] as const;

export function inspectRealtimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RealtimeEnvironmentSnapshot {
  const warnings: string[] = [];
  const PLACEHOLDER_KEY_PATTERN = /^sk[-_]?your/i;

  const apiKey =
    env.OPENAI_API_KEY ?? env.OPENAI_REALTIME_API_KEY ?? env.OPENAI_API_KEY_VOICE ?? '';
  if (!apiKey) {
    warnings.push('Realtime API key is not configured (OPENAI_API_KEY / OPENAI_REALTIME_API_KEY).');
  } else if (PLACEHOLDER_KEY_PATTERN.test(apiKey)) {
    warnings.push('Realtime API key is using a placeholder value.');
  }

  const audioExplicitlyDisabled =
    (env.OPENAI_REALTIME_AUDIO_DISABLED ?? '').toLowerCase() === 'true';
  const missingAudioKeys = AUDIO_REQUIREMENT_KEYS.filter((key) => !env[key]);
  let audioEnabled = !audioExplicitlyDisabled && missingAudioKeys.length === 0;
  let audioReason: string | undefined;

  if (audioExplicitlyDisabled) {
    audioReason = 'Audio capability explicitly disabled via OPENAI_REALTIME_AUDIO_DISABLED.';
  } else if (missingAudioKeys.length > 0) {
    audioReason = `Audio output disabled: missing ${missingAudioKeys.join(', ')}`;
  }

  if (audioReason) {
    warnings.push(audioReason);
  }

  return {
    warnings,
    audio: {
      enabled: audioEnabled,
      reason: audioReason,
    },
  };
}
