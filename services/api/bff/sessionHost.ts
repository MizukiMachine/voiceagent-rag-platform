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
  classifyDeepReasoningIntent,
  runDeepReasoning,
  warmupModel,
  type ResponsesClient,
} from './sessionHost/deepReasoning';
import { getUserProfile, resolveUserId } from '../../../services/nutrition/profileService';
import {
  buildReplayEvents,
  getPersistentMemoryStore,
  PERSISTENT_MEMORY_ENABLED,
  PERSISTENT_MEMORY_SOURCE,
  resolveMemoryKey,
  toMemoryEntry,
  type MemoryStore,
  type MemoryEntry,
} from '../../coreData/persistentMemory';
import {
  getCurrentTimeInTimeZone,
  IntlTimeContextProvider,
  TimeContextProvider,
  timeContextProviderToken,
} from '../../../framework/time/TimeContextProvider';

const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_MAX_LIFETIME_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const STREAM_IDLE_CLEANUP_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 10;
const PERSISTENT_MEMORY_REPLAY_LIMIT =
  Number(process.env.PERSISTENT_MEMORY_REPLAY_LIMIT ?? '') || 30;
const DEEP_REASONING_PLACEHOLDER_TEXT =
  process.env.DEEP_REASONING_PLACEHOLDER_TEXT ?? '少々お待ちください。丁寧に考えています…';
const DEEP_REASONING_TIMEOUT_MS =
  Number(process.env.DEEP_REASONING_TIMEOUT_MS ?? '') || 45_000;

const HOTWORD_TIMEOUT_MS = Number(process.env.HOTWORD_TIMEOUT_MS ?? '') || 8000;
const HOTWORD_REMINDER_DISCONNECT_DELAY_MS =
  Number(process.env.HOTWORD_REMINDER_DISCONNECT_DELAY_MS ?? '') || 2000;
const HOTWORD_REMINDER_TEXT =
  process.env.HOTWORD_REMINDER_TEXT ?? 'ホットワード「Hey + シナリオ名」で話しかけてください。';
const HOTWORD_REMINDER_ENABLED = false;
const HOTWORD_REQUIRE_PREFIX = (process.env.HOTWORD_REQUIRE_PREFIX ?? 'false') === 'true';
const HOTWORD_LLM_ENABLED = (process.env.HOTWORD_LLM_ENABLED ?? 'true') === 'true';
const HOTWORD_LLM_MODEL = process.env.HOTWORD_LLM_MODEL ?? 'gpt-5-mini';
const HOTWORD_LLM_MIN_CONFIDENCE = Number(process.env.HOTWORD_LLM_MIN_CONFIDENCE ?? '0.6');
const HOTWORD_FUZZY_DISTANCE_THRESHOLD =
  Number(process.env.HOTWORD_FUZZY_DISTANCE_THRESHOLD ?? '2');
const HOTWORD_MIN_CONFIDENCE = Number(process.env.HOTWORD_MIN_CONFIDENCE ?? '0.6');
const HOTWORD_CUE_ENABLED = (process.env.HOTWORD_CUE_ENABLED ?? 'true') === 'true';
const HOTWORD_SWITCH_DELAY_MS = Number(process.env.HOTWORD_SWITCH_DELAY_MS ?? '200');
const ASSISTANT_SPEECH_IDLE_MS = 1200;
const DEFAULT_HOTWORD_CONTINUATION_WINDOW_MS = 2000;
const DEEP_REASONING_TRIGGERS = ['深く考えて', 'じっくり', '丁寧に考えて', '理由を詳しく', 'ステップを教えて'];
const BARGE_IN_ENABLED = (process.env.BARGE_IN_ENABLED ?? 'true') === 'true';

function resolveHotwordContinuationWindowMs(): number {
  const configured = Number(process.env.HOTWORD_CONTINUATION_WINDOW_MS ?? '');
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_HOTWORD_CONTINUATION_WINDOW_MS;
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
   timeZone?: string;
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
  timeZone: string;
  currentTimeIso: string;
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
  hasLiveUserInput: boolean;
  latestProfileContext?: string;
  hotwordListener?: HotwordListener;
  scenarioRouter?: ScenarioRouter;
  hotwordReminderTimer?: ReturnType<typeof setTimeout>;
  hotwordCuePlayedItems: Set<string>;
  isAssistantSpeaking: boolean;
  assistantSilenceTimer?: ReturnType<typeof setTimeout>;
  transcribedItemIds: Set<string>;
  clientTag?: string;
  destroyed?: boolean;
  deepReasoningJob?: {
    id: string;
    profileContext?: string;
    placeholderItemId?: string;
    timeout?: ReturnType<typeof setTimeout>;
  };
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
  responsesClientFactory?: () => ResponsesClient;
  intentClassifier?: (text: string) => Promise<boolean>;
  deepReasoningLogSampleLimit?: number;
  timeContextProvider?: TimeContextProvider;
  defaultTimeZone?: string;
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
  private readonly registryServiceManager: ServiceManager;
  private readonly memoryStore: MemoryStore;
  private readonly scenarioRegistry: ScenarioRegistry;
  private readonly hotwordCueService: HotwordCueService;
  private readonly hotwordReminderEnabled: boolean;
  private readonly hotwordReminderDisconnectDelayMs: number;
  private readonly hotwordCueEnabled: boolean;
  private readonly responsesClientFactory: () => ResponsesClient;
  private readonly intentClassifier: (text: string) => Promise<boolean>;
  private readonly deepReasoningLogSampleLimit: number;
  private readonly deepReasoningTimeoutMs: number;
  private readonly timeContextProvider: TimeContextProvider;

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
    this.deepReasoningLogSampleLimit = deps.deepReasoningLogSampleLimit ?? 800;
    this.deepReasoningTimeoutMs = DEEP_REASONING_TIMEOUT_MS;

    this.responsesClientFactory =
      deps.responsesClientFactory ??
      (() => {
        const apiKey = this.getResponsesApiKey();
        const client = new OpenAI({ apiKey });
        return client.responses;
      });

    this.intentClassifier =
      deps.intentClassifier ??
      ((text: string) => classifyDeepReasoningIntent(text, this.responsesClientFactory(), this.logger));

    this.registryServiceManager = deps.serviceManager ?? new ServiceManager({ logger: this.logger });
    this.timeContextProvider =
      deps.timeContextProvider ??
      this.registerAndGetTimeContextProvider(this.registryServiceManager, deps.defaultTimeZone);

    const mcpConfigs = loadMcpServersFromEnv();
    const hasBindings = Object.values(this.scenarioMcpBindings).some(
      (binding) => binding.requiredMcpServers?.length > 0,
    );
    if (hasBindings && Object.keys(mcpConfigs).length > 0) {
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

  private registerAndGetTimeContextProvider(
    serviceManager: ServiceManager,
    defaultTimeZone?: string,
  ): TimeContextProvider {
    if (!serviceManager.has(timeContextProviderToken)) {
      serviceManager.register(
        timeContextProviderToken,
        () => new IntlTimeContextProvider({ defaultTimeZone, logger: this.logger }),
      );
    }
    return serviceManager.get(timeContextProviderToken);
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
            const itemId = typeof payload?.item_id === 'string' ? payload.item_id : undefined;
            if (itemId) {
              contextRef.current?.transcribedItemIds.add(itemId);
            }
            this.trackAssistantSpeech(contextRef.current, payload);
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

  /**
   * clientTag に紐づくセッションがあれば破棄する。
   * メモリリセット時に既存セッションが古い履歴を再度書き戻すのを防ぐため。
   */
  async destroySessionsByClientTag(clientTag: string, reason = 'memory_reset'): Promise<boolean> {
    const binding = this.clientTagIndex.get(clientTag);
    if (!binding?.sessionId) return false;
    return this.destroySession(binding.sessionId, { reason, initiatedBy: 'system' });
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
      ? resolveMemoryKey(options.agentSetKey, options.memoryKey, options.metadata, options.clientTag)
      : null;

    const manager = this.sessionManagerFactory(hooks);
    const sessionMetadata = { ...(options.metadata ?? {}) };
    if (options.clientTag && !sessionMetadata.clientTag) {
      sessionMetadata.clientTag = options.clientTag;
    }
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
    // 深考モデルのウォームアップを並行で走らせ、初回遅延を吸収
    Promise.resolve()
      .then(() => this.responsesClientFactory())
      .then((client) => warmupModel(client, this.logger))
      .catch((error) => this.logger.info('Deep reasoning warmup skipped', { error }));
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
      mergeWindowMs: resolveHotwordContinuationWindowMs(),
      scenarioSwitchDelayMs: HOTWORD_SWITCH_DELAY_MS,
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
        // delta段階は誤検知が起きやすいので通知のみ。キュー音はcompleted判定で送る。
        if (detection.stage === 'delta') {
          return;
        }
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

    const timeContext = this.timeContextProvider.getContext(options.timeZone);
    if (timeContext.usedFallback) {
      this.logger.warn('timezone fallback applied for session', {
        sessionId,
        requestedTimeZone: timeContext.requestedTimeZone,
        timeZone: timeContext.timeZone,
        reason: timeContext.fallbackReason ?? 'missing',
      });
    }
    const capabilityWarnings = [...envSnapshot.warnings];
    if (timeContext.usedFallback) {
      capabilityWarnings.push(
        `timezone_fallback:${timeContext.fallbackReason ?? 'missing'}:${timeContext.requestedTimeZone ?? 'null'}`,
      );
    }

    await manager.connect({
      agentSetKey: options.agentSetKey,
      preferredAgentName: options.preferredAgentName,
      getEphemeralKey: async () => this.getRealtimeApiKey(),
      extraContext: {
        sessionLabel: options.sessionLabel,
        clientTag: options.clientTag,
        metadata: sessionMetadata,
        clientCapabilities: options.clientCapabilities ?? {},
        requestScenarioChange: voiceControlHandlers.requestScenarioChange,
        requestAgentChange: voiceControlHandlers.requestAgentChange,
        persistentMemoryKey: memoryKey ?? undefined,
        currentTimeIso: timeContext.currentTimeIso,
        timeZone: timeContext.timeZone,
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
      agentSet: {
        key: options.agentSetKey,
        primary: agentSet[0]?.name ?? 'agent',
      },
      timeZone: timeContext.timeZone,
      currentTimeIso: timeContext.currentTimeIso,
      capabilityWarnings,
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
      isAssistantSpeaking: false,
      transcribedItemIds: new Set(),
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
      hasLiveUserInput: false,
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
        await this.handleInputText(context, command);
        break;
      case 'input_audio':
        await this.handleInputAudio(context, command);
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
    context.hasLiveUserInput = true;
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

  private enqueueTextMessage(
    context: SessionContext,
    role: 'user' | 'system' | 'assistant',
    text: string,
  ) {
    if (!text || text.trim().length === 0) return;
    context.manager.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role,
        content: [
          {
            type: 'input_text',
            text,
          },
        ],
      },
    });
  }

  private async handleInputText(
    context: SessionContext,
    command: Extract<SessionCommand, { kind: 'input_text' }>,
  ) {
    const text = command.text ?? '';
    if (context.scenarioRouter?.appendContinuation(text)) {
      return;
    }

    const isNutritionScenario = context.agentSetKey === 'nutrition';
    if (isNutritionScenario) {
      const profileContext = await this.fetchAndInjectProfileContext(context, command.metadata);
      this.logger.info('Nutrition scenario: deep reasoning pipeline engaged', { sessionId: context.id });
      this.executeDeepReasoningPipeline(context, text, command.metadata, profileContext).catch((error) => {
        this.logger.error('Deep reasoning pipeline failed; forwarding to realtime as fallback', {
          sessionId: context.id,
          error,
        });
        this.sendUserTextCommand(context, text, command.metadata);
      });
      return;
    }

    const keywordHit = this.shouldForceDeepReasoning(text);
    const llmHit = keywordHit ? true : await this.intentClassifier(text);

    if (llmHit) {
      this.logger.info('Deep reasoning trigger detected; executing responses API pipeline', {
        sessionId: context.id,
        keywordHit,
      });
      this.executeDeepReasoningPipeline(context, text, command.metadata).catch((error) => {
        this.logger.error('Deep reasoning pipeline failed; forwarding to realtime as usual', {
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

  private formatProfileContext(profile: any): string {
    if (!profile || typeof profile !== 'object') return '';
    const lines: string[] = [];
    const push = (label: string, value: any) => {
      if (value === undefined || value === null) return;
      if (Array.isArray(value)) {
        if (value.length === 0) return;
        lines.push(`${label}: ${value.join(', ')}`);
        return;
      }
      if (typeof value === 'object') return;
      const str = String(value).trim();
      if (str.length === 0) return;
      lines.push(`${label}: ${str}`);
    };

    push('goalType', profile.goalType);
    push('activityLevel', profile.activityLevel);
    push('age', profile.age);
    push('sex', profile.sex);
    push('heightCm', profile.heightCm);
    push('weightKg', profile.weightKg);
    push('avoidFoods', profile.avoidFoods ?? profile.allergies ?? profile.dislikedFoods);
    push('recentMeals', profile.recentMeals ?? profile.recent_meals);
    push('todayMeals', profile.todayMeals ?? profile.today_meals);
    push('dinner', profile.dinner);

    if (Array.isArray(profile.mealLogs) && profile.mealLogs.length > 0) {
      const sorted = [...profile.mealLogs].sort((a, b) => {
        const aTime = new Date(a?.recordedAt ?? 0).getTime();
        const bTime = new Date(b?.recordedAt ?? 0).getTime();
        return bTime - aTime;
      });
      const formatter = new Intl.DateTimeFormat('ja-JP', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const recent = sorted.slice(0, 6).map((log) => {
        const timeLabel = log?.recordedAt ? formatter.format(new Date(log.recordedAt)) : '??-?? ??';
        const slot = log?.timeOfDay ? `${log.timeOfDay}` : '';
        const description = typeof log?.description === 'string' ? log.description.trim() : '';
        const base = description || '内容未設定';
        return slot ? `${timeLabel} ${slot}:${base}` : `${timeLabel}:${base}`;
      });
      push('mealLogsRecent', recent.join(' | '));
      push('mealLogCount', profile.mealLogs.length);
    }

    return lines.join('\n');
  }

  private async fetchProfileContext(
    metadata?: Record<string, any>,
    clientTag?: string | null,
  ): Promise<string | undefined> {
    const userId = typeof metadata?.userId === 'string' ? metadata.userId : undefined;
    const resolvedUserId = resolveUserId(userId);
    const resolvedClientTag = typeof clientTag === 'string' && clientTag.trim() ? clientTag.trim() : undefined;

    const httpTimeoutMs = Number(process.env.PROFILE_FETCH_TIMEOUT_MS ?? '') || 1200;
    const profileBase =
      process.env.PROFILE_API_BASE?.trim() ||
      process.env.INTERNAL_PROFILE_API_BASE?.trim() ||
      process.env.NEXT_PUBLIC_PROFILE_API_BASE?.trim() ||
      '';
    const allowLocalFallback = (process.env.PROFILE_FETCH_LOCAL_FALLBACK ?? 'true') === 'true';
    const ts = Date.now();
    const queryParams = new URLSearchParams();
    if (resolvedUserId) queryParams.set('user_id', resolvedUserId);
    if (resolvedClientTag) queryParams.set('client_tag', resolvedClientTag);
    queryParams.set('_', String(ts));
    const query = `?${queryParams.toString()}`;
    const url = profileBase ? `${profileBase}/api/debug/profile${query}` : null;

    const httpProfile = await (async () => {
      if (!url) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
      try {
        const res = await fetch(url, {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn('Profile HTTP fetch failed', { url, status: res.status });
          return null;
        }
        const json: any = await res.json();
        return json?.profile ?? null;
      } catch (error) {
        const aborted = (error as any)?.name === 'AbortError';
        this.logger[aborted ? 'info' : 'warn']('Profile HTTP fetch skipped', { url, aborted, error });
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();

    if (httpProfile) {
      return this.formatProfileContext(httpProfile);
    }

    if (allowLocalFallback) {
      try {
        const localProfile = await getUserProfile(resolvedUserId, resolvedClientTag);
        return this.formatProfileContext(localProfile);
      } catch (error) {
        this.logger.warn('Local profile read failed', { userId: resolvedUserId, error });
        return undefined;
      }
    }

    this.logger.warn('Profile fetch fell back to none (local fallback disabled)', { userId: resolvedUserId });
    return undefined;
  }

  private async fetchAndInjectProfileContext(
    context: SessionContext,
    metadata?: Record<string, any>,
  ): Promise<string | undefined> {
    const profileContext = await this.fetchProfileContext(metadata, context.clientTag);
    if (!profileContext || profileContext.trim().length === 0) {
      return profileContext;
    }

    if (context.latestProfileContext !== profileContext) {
      context.latestProfileContext = profileContext;
      this.enqueueTextMessage(
        context,
        'system',
        '【内部メモ・読み上げ禁止】最新プロフィールを必ず考慮して回答してください。\n' + profileContext,
      );
    }

    return profileContext;
  }

  private startDeepReasoningJob(
    context: SessionContext,
    question?: string,
    metadata?: Record<string, any>,
    profileContext?: string,
  ) {
    if (context.deepReasoningJob?.timeout) {
      clearTimeout(context.deepReasoningJob.timeout);
    }
    const id = randomUUID();
    const timeout = setTimeout(() => {
      if (!this.isDeepReasoningJobCurrent(context, id)) return;
      this.logger.warn('Deep reasoning timed out; falling back', { sessionId: context.id });
      const placeholderId = context.deepReasoningJob?.placeholderItemId;
      this.deleteTranscriptItem(context, placeholderId);
      this.clearDeepReasoningJob(context);
      this.sendRealtimeFallback(context, question ?? '前の質問', metadata, context.deepReasoningJob?.profileContext);
    }, this.deepReasoningTimeoutMs);
    context.deepReasoningJob = { id, timeout, profileContext };
  }

  private clearDeepReasoningJob(context: SessionContext) {
    if (context.deepReasoningJob?.timeout) {
      clearTimeout(context.deepReasoningJob.timeout);
    }
    context.deepReasoningJob = undefined;
  }

  private isDeepReasoningJobCurrent(context: SessionContext, id?: string): boolean {
    if (!context.deepReasoningJob) return false;
    if (id) return context.deepReasoningJob.id === id;
    return true;
  }

  private sendDeepReasoningPlaceholder(context: SessionContext): string | undefined {
    try {
      const placeholderItemId = `deep_placeholder_${randomUUID().slice(0, 8)}`;
      // システム指示として短い待機メッセージをRealtimeに生成させる
      context.manager.sendEvent({
        type: 'conversation.item.create',
        item: {
          id: placeholderItemId,
          type: 'message',
          role: 'system',
          content: [
            {
              type: 'input_text',
              text:
                '次の応答では「' +
                DEEP_REASONING_PLACEHOLDER_TEXT +
                '」とだけ一度話し、すぐ終了してください。追加説明や二回以上の発話は不要です。',
            },
          ],
        },
      });
      context.manager.sendEvent({ type: 'response.create' });
      if (context.deepReasoningJob) {
        context.deepReasoningJob.placeholderItemId = placeholderItemId;
      }
      return placeholderItemId;
    } catch (error) {
      this.logger.warn('Failed to send deep reasoning placeholder', { sessionId: context.id, error });
      return undefined;
    }
  }

  private async executeDeepReasoningPipeline(
    context: SessionContext,
    question: string,
    metadata?: Record<string, any>,
    profileContextOverride?: string,
  ): Promise<void> {
    const profileContext = profileContextOverride ?? (await this.fetchProfileContext(metadata));
    this.startDeepReasoningJob(context, question, metadata, profileContext);
    const placeholderId = this.sendDeepReasoningPlaceholder(context);

    let result: Awaited<ReturnType<typeof runDeepReasoning>> | null = null;
    try {
      const client = this.responsesClientFactory();
      result = await runDeepReasoning({
        question,
        profileContext,
        client,
        logger: this.logger,
        logSampleLimit: this.deepReasoningLogSampleLimit,
        maxOutputTokens: Number(process.env.DEEP_REASONING_MAX_OUTPUT_TOKENS ?? '') || undefined,
      });
    } catch (error) {
      this.logger.error('Deep reasoning execution failed', { sessionId: context.id, error });
      this.deleteTranscriptItem(context, placeholderId);
      this.clearDeepReasoningJob(context);
      throw error;
    }

    if (!this.isDeepReasoningJobCurrent(context)) {
      this.logger.info('Deep reasoning job superseded; discarding result', {
        sessionId: context.id,
      });
      this.clearDeepReasoningJob(context);
      return;
    }

    this.clearDeepReasoningJob(context);
    this.deleteTranscriptItem(context, placeholderId);

    if (result.outcome === 'success' && result.text) {
      this.logger.info('Deep reasoning succeeded; relaying answer to realtime', {
        sessionId: context.id,
        responseSummary: result.responseSummary,
      });
      this.sendDeepReasoningAnswerToRealtime(context, question, result.text);
      this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'deep_reasoning_success' });
      return;
    }

    this.logger.warn('Deep reasoning empty or refusal; falling back to realtime generation', {
      sessionId: context.id,
      responseSummary: result.responseSummary,
    });
    this.sendRealtimeFallback(context, question, metadata, profileContext);
    this.metrics.increment('bff.session.event_forwarded_total', 1, { kind: 'deep_reasoning_fallback' });
  }

  private sendDeepReasoningAnswerToRealtime(context: SessionContext, question: string, assistantText: string) {
    context.hasUserContent = true;
    context.hasLiveUserInput = true;
    this.enqueueTextMessage(context, 'user', question);
    this.enqueueTextMessage(
      context,
      'system',
      '【内部メモ・読み上げ禁止】以下は最終回答。これをそのまま日本語音声で読み上げる。\n\n最終回答:\n' +
        assistantText,
    );
    context.manager.sendEvent({ type: 'response.create' });
  }

  private sendRealtimeFallback(
    context: SessionContext,
    question: string,
    metadata?: Record<string, any>,
    profileContext?: string,
  ) {
    context.hasUserContent = true;
    context.hasLiveUserInput = true;
    if (profileContext && profileContext.trim().length > 0) {
      this.enqueueTextMessage(
        context,
        'system',
        '【内部メモ・読み上げ禁止】最新プロフィールを考慮して回答してください。\n' + profileContext,
      );
    }
    this.enqueueTextMessage(
      context,
      'system',
      '【内部メモ・読み上げ禁止】深考パイプラインで回答が得られなかったため、リアルタイムで丁寧な回答を生成してください。ユーザーには通常どおり回答してください。',
    );
    this.enqueueTextMessage(context, 'user', question);
    context.manager.sendEvent({ type: 'response.create' });
  }

  private async handleInputAudio(context: SessionContext, command: Extract<SessionCommand, { kind: 'input_audio' }>) {
    if (context.agentSetKey === 'nutrition') {
      await this.fetchAndInjectProfileContext(context);
    }
    if (!BARGE_IN_ENABLED && context.isAssistantSpeaking) {
      this.logger.info('Dropping input_audio because assistant is speaking and barge-in is disabled', {
        sessionId: context.id,
      });
      return;
    }
    context.hasUserContent = true;
    context.hasLiveUserInput = true;
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
    context.hasLiveUserInput = true;
    // 画像は全シナリオ共通でRealtime経路に乗せる（Nadiaの料理画像質問もdeep reasoningには送らない）。
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
    if (command.event?.type === 'response.create' && !context.hasLiveUserInput) {
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
        if (!BARGE_IN_ENABLED) {
          this.logger.info('Barge-in disabled by env; interrupt ignored', {
            sessionId: context.id,
          });
          this.metrics.increment('bff.session.barge_in_blocked_total', 1);
          return;
        }
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
          const filtered = this.normalizeHistoryPayload(payload)
            .filter((item) => !this.isPersistentMemoryReplay(item))
            .filter((item) => this.shouldForwardHistoryItem(context, item));

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
      const keysToRead = this.buildMemoryReadKeys(context);
      const entries = await this.readMergedPersistentEntries(
        context.memoryKey,
        keysToRead,
        PERSISTENT_MEMORY_REPLAY_LIMIT,
      );
      if (keysToRead.some((key) => key !== context.memoryKey)) {
        await this.migrateLegacyKeys(context.memoryKey, keysToRead, entries);
      }
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
        legacyKeys: keysToRead.filter((k) => k !== context.memoryKey),
        count: events.length,
      });
    } catch (error) {
      this.logger.warn('Failed to replay persistent memory', {
        sessionId: context.id,
        memoryKey: context.memoryKey,
        error,
      });
      this.broadcast(context.id, 'session_error', {
        code: 'memory_replay_failed',
        message: '過去の記憶を再適用できませんでした（会話は継続します）',
        retryable: false,
      });
    }
  }

  private buildMemoryReadKeys(context: SessionContext): string[] {
    const keys = new Set<string>();
    if (context.memoryKey) keys.add(context.memoryKey);
    if (context.clientTag) {
      const legacyKey = `${context.agentSetKey}:${context.clientTag}`;
      if (!keys.has(legacyKey)) keys.add(legacyKey);
    }
    return Array.from(keys);
  }

  private async readMergedPersistentEntries(primaryKey: string, keys: string[], limit: number): Promise<MemoryEntry[]> {
    const latestByItem: Map<string, MemoryEntry> = new Map();
    for (const key of keys) {
      const list = await this.memoryStore.read(key);
      list.forEach((entry) => {
        const uid = entry.itemId ?? `${key}:${entry.createdAt}`;
        const existing = latestByItem.get(uid);
        if (!existing) {
          latestByItem.set(uid, entry);
        } else if (new Date(entry.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
          latestByItem.set(uid, entry);
        }
      });
    }
    const merged = Array.from(latestByItem.values());
    merged.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const trimmed = this.trimTrailingUnansweredUser(merged);
    return trimmed.slice(-limit);
  }

  private async migrateLegacyKeys(primaryKey: string, keys: string[], entries: MemoryEntry[]): Promise<void> {
    const legacyKeys = keys.filter((key) => key !== primaryKey);
    if (legacyKeys.length === 0) return;

    // Write merged entries into primary
    await Promise.all(
      entries.map((entry) => this.memoryStore.upsert(primaryKey, entry).catch(() => undefined)),
    );

    // Remove legacy keys to avoid次回以降の二重リプレイ
    await Promise.all(legacyKeys.map((key) => this.memoryStore.reset(key).catch(() => undefined)));
  }

  private trimTrailingUnansweredUser(entries: MemoryEntry[]): MemoryEntry[] {
    return entries;
  }

  private async persistMemoryFromHistory(context: SessionContext, payload: any): Promise<void> {
    if (!context.memoryKey) return;
    const items = Array.isArray(payload) ? payload : [payload];
    const now = this.now();
    const entries = items
      .map((item) => toMemoryEntry(item, now))
      .filter((entry): entry is NonNullable<ReturnType<typeof toMemoryEntry>> => Boolean(entry));

    if (entries.length === 0) return;
    if (entries.some((entry) => entry.role === 'user')) {
      context.hasLiveUserInput = true;
    }

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
    const id =
      payload?.id ??
      payload?.item_id ??
      payload?.itemId ??
      payload?.item?.id ??
      payload?.item?.itemId;
    if (typeof id === 'string' && id.startsWith('pm:')) return true;
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

  private trackAssistantSpeech(context: SessionContext | null, payload: any) {
    if (!context || !payload) return;
    const type = typeof payload?.type === 'string' ? payload.type : '';
    const outputAudio =
      type === 'response.output_audio.delta' ||
      type === 'response.output_audio.chunk' ||
      type === 'response.output_audio.done';
    const responseDone = type === 'response.completed' || type === 'response.done';

    if (outputAudio) {
      context.isAssistantSpeaking = true;
      if (context.assistantSilenceTimer) {
        clearTimeout(context.assistantSilenceTimer);
      }
      context.assistantSilenceTimer = setTimeout(() => {
        context.isAssistantSpeaking = false;
        context.assistantSilenceTimer = undefined;
      }, ASSISTANT_SPEECH_IDLE_MS);
    } else if (responseDone) {
      context.isAssistantSpeaking = false;
      if (context.assistantSilenceTimer) {
        clearTimeout(context.assistantSilenceTimer);
        context.assistantSilenceTimer = undefined;
      }
    }
  }

  private shouldForwardHistoryItem(context: SessionContext, item: any): boolean {
    const itemId =
      item?.id ?? item?.item_id ?? item?.itemId ?? item?.item?.id ?? item?.item?.itemId;
    if (itemId && context.transcribedItemIds.has(itemId)) {
      // 音声入力の生トランスクリプトはホットワード確定までサンドボックス扱い
      return false;
    }
    return true;
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
    if (context.assistantSilenceTimer) {
      clearTimeout(context.assistantSilenceTimer);
      context.assistantSilenceTimer = undefined;
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

  private getResponsesApiKey(): string {
    const apiKey =
      process.env.OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY_RESPONSES ??
      process.env.OPENAI_API_KEY_VOICE ??
      process.env.OPENAI_REALTIME_API_KEY;
    if (!apiKey) {
      throw new SessionHostError('Responses API key is not configured', 'missing_api_key', 500);
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
