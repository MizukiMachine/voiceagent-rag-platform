"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

import Image from "next/image";

// UI components
import Transcript from "./components/Transcript";
import Events from "./components/Events";
import BottomToolbar from "./components/BottomToolbar";
import { CameraCapturePanel } from "./components/CameraCapturePanel";
import { ImageUploadPanel } from "./components/ImageUploadPanel";

// Types
import { SessionStatus } from "@/app/types";
import type { RealtimeAgent } from '@openai/agents/realtime';
import type { VoiceControlDirective, ScenarioChangeOptions } from '@/shared/voiceControl';

// Context providers & hooks
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import { useRealtimeSession } from "./hooks/useRealtimeSession";
import { useMicrophoneStream } from "./hooks/useMicrophoneStream";

// Agent configs
import { allAgentSets, agentSetMetadata, defaultAgentSetKey } from "@/app/agentConfigs";
import { normalizeScenarioKey } from "@/shared/scenarioAliases";


import useAudioDownload from "./hooks/useAudioDownload";
import { useHandleSessionHistory } from "./hooks/useHandleSessionHistory";
import { formatUiText, uiText } from "./i18n";

const SERVER_VAD_TEMPLATE = {
  type: 'server_vad' as const,
  threshold: 0.9,
  prefix_padding_ms: 300,
  silence_duration_ms: 1000,
};

function resolveBffKeyForClient(): string | undefined {
  if (typeof window !== 'undefined' && (window as any).__MCPC_BFF_KEY) {
    return (window as any).__MCPC_BFF_KEY;
  }
  return process.env.NEXT_PUBLIC_BFF_KEY;
}

function buildBffHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const bffKey = resolveBffKeyForClient();
  if (bffKey) {
    headers['x-bff-key'] = bffKey;
  }
  return headers;
}

function App() {
  const searchParams = useSearchParams()!;
  const router = useRouter();
  const pathname = usePathname();
  const shouldAutoConnect = searchParams.get("autoConnect") === "true";
  // ---------------------------------------------------------------------
  // Codec selector – lets you toggle between wide-band Opus (48 kHz)
  // and narrow-band PCMU/PCMA (8 kHz) to hear what the agent sounds like on
  // a traditional phone line and to validate ASR / VAD behaviour under that
  // constraint.
  //
  // We read the `?codec=` query-param and rely on the `changePeerConnection`
  // hook (configured in `useRealtimeSession`) to set the preferred codec
  // before the offer/answer negotiation.
  // ---------------------------------------------------------------------
  const urlCodec = searchParams.get("codec") || "opus";

  // Agents SDK doesn't currently support codec selection so it is now forced 
  // via global codecPatch at module load 

  const { addTranscriptBreadcrumb } = useTranscript();
  const { logClientEvent, generateRequestId } = useEvent();

  const [agentSetKey, setAgentSetKey] = useState<string>(defaultAgentSetKey);
  const [selectedAgentName, setSelectedAgentName] = useState<string>("");
  const [selectedAgentConfigSet, setSelectedAgentConfigSet] = useState<
    RealtimeAgent[] | null
  >(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isResettingMemory, setIsResettingMemory] = useState<boolean>(false);
  const [memoryKeysByScenario, setMemoryKeysByScenario] = useState<Record<string, string>>({});
  const [activeMemoryKey, setActiveMemoryKey] = useState<string | null>(null);

  // Ref to identify whether the latest agent switch came from an automatic handoff
  const handoffTriggeredRef = useRef(false);
  const initialResponseTriggeredRef = useRef(false);
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("DISCONNECTED");
  const [isSessionReady, setIsSessionReady] = useState(false);
  const pendingVoiceReconnectRef = useRef(false);
  const pendingInitialCommandRef = useRef<string | null>(null);
  const sendUserTextRef = useRef<((text: string) => void) | null>(null);
  const [isPTTActive, setIsPTTActive] = useState<boolean>(false);

  const [isEventsPaneExpanded, setIsEventsPaneExpanded] =
    useState<boolean>(true);
  const [userText, setUserText] = useState<string>("");
  const [isPTTUserSpeaking, setIsPTTUserSpeaking] = useState<boolean>(false);
  const [isAudioPlaybackEnabled, setIsAudioPlaybackEnabled] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return true;
      const stored = localStorage.getItem('audioPlaybackEnabled');
      return stored ? stored === 'true' : true;
    },
  );
  const [isBargeInDisabled, setIsBargeInDisabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const stored = localStorage.getItem('bargeInDisabled');
    return stored ? stored === 'true' : false;
  });
  const [isTextOutputEnabled, setIsTextOutputEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('textOutputEnabled');
    return stored ? stored === 'true' : true;
  });
  const [clientTag, setClientTag] = useState<string>(() => {
    if (typeof window === 'undefined') return 'develop';
    return localStorage.getItem('clientTag') ?? 'develop';
  });

  const schedulePostToolAction = useCallback((action: () => void) => {
    setTimeout(action, 0);
  }, []);

  // Initialize the recording hook.
  const { stopRecording, downloadRecording } = useAudioDownload();

  const sendClientEvent = (eventObj: any, eventNameSuffix = "") => {
    const requestId = generateRequestId();
    try {
      sendEvent(eventObj);
      logClientEvent(eventObj, eventNameSuffix, { requestId });
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }
  };

  useHandleSessionHistory();
  const { clearTranscript } = useTranscript();

  useEffect(() => {
    const requested = searchParams.get("agentConfig");
    if (!requested) return;
    if (!allAgentSets[requested]) return;

    setAgentSetKey((prev) => (prev === requested ? prev : requested));

    const next = new URLSearchParams(searchParams.toString());
    next.delete("agentConfig");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    const tagParam = searchParams.get("clientTag");
    if (tagParam) {
      setClientTag(tagParam);
    }
  }, [searchParams]);

  useEffect(() => {
    const agents = allAgentSets[agentSetKey] ?? [];
    setSelectedAgentConfigSet(agents);
    setSelectedAgentName((prev) => {
      if (prev && agents.some((agent) => agent.name === prev)) {
        return prev;
      }
      return agents[0]?.name ?? "";
    });
  }, [agentSetKey]);

  useEffect(() => {
    if (
      shouldAutoConnect &&
      selectedAgentName &&
      sessionStatus === "DISCONNECTED"
    ) {
      connectToRealtime("auto");
    }
  }, [shouldAutoConnect, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus === "CONNECTED" &&
      selectedAgentConfigSet &&
      selectedAgentName
    ) {
      const currentAgent = selectedAgentConfigSet.find(
        (a) => a.name === selectedAgentName
      );
      addTranscriptBreadcrumb(
        `${uiText.session.agentBreadcrumbLabel}${selectedAgentName}`,
        currentAgent,
      );
      const shouldTriggerInitialResponse = false;
      updateSession(shouldTriggerInitialResponse);
      // Reset flag after handling so subsequent effects behave normally
      handoffTriggeredRef.current = false;
    }
  }, [selectedAgentConfigSet, selectedAgentName, sessionStatus]);

  useEffect(() => {
    if (sessionStatus === "CONNECTED") {
      updateSession();
    }
  }, [isPTTActive]);

  const disconnectFromRealtime = () => {
    disconnect();
    setIsPTTUserSpeaking(false);
    initialResponseTriggeredRef.current = false;
    clearTranscript();
  };

  const handleTextOutputPreferenceChange = useCallback(
    (enabled: boolean) => {
      setIsTextOutputEnabled(enabled);
      if (sessionStatus === 'CONNECTED') {
        pendingVoiceReconnectRef.current = true;
        disconnectFromRealtime();
      }
    },
    [disconnectFromRealtime, sessionStatus],
  );

    const requestScenarioChange = useCallback(
    async (scenarioKey: string, options?: ScenarioChangeOptions) => {
      const normalizedKey = normalizeScenarioKey(scenarioKey);
      addTranscriptBreadcrumb('Voice scenario switch request', { scenarioKey });
      if (!allAgentSets[normalizedKey]) {
        return {
          success: false,
          message: formatUiText(uiText.voiceControl.unknownScenario, { scenarioKey }),
        };
      }
      if (options?.initialCommand) {
        pendingInitialCommandRef.current = options.initialCommand;
      }
      if (normalizedKey === agentSetKey) {
        if (options?.initialCommand && sessionStatus === 'CONNECTED') {
          sendUserTextRef.current?.(options.initialCommand);
          pendingInitialCommandRef.current = null;
        }
        return {
          success: true,
          message: formatUiText(uiText.voiceControl.alreadyInScenario, { scenarioKey }),
        };
      }
      schedulePostToolAction(() => {
        setAgentSetKey(normalizedKey);
        pendingVoiceReconnectRef.current = true;
        disconnectFromRealtime();
      });
      return {
        success: true,
        message: formatUiText(uiText.voiceControl.switchingScenario, { scenarioKey }),
      };
    },
    [
      addTranscriptBreadcrumb,
      agentSetKey,
      disconnectFromRealtime,
      schedulePostToolAction,
      sessionStatus,
      normalizeScenarioKey,
    ],
  );

const requestAgentChange = useCallback(async (agentName: string) => {
    addTranscriptBreadcrumb('Voice agent switch request', { agentName });
    const agents = selectedAgentConfigSet ?? [];
    if (!agents.some((agent) => agent.name === agentName)) {
      return {
        success: false,
        message: formatUiText(uiText.voiceControl.unknownAgent, { agentName }),
      };
    }
    if (agentName === selectedAgentName) {
      return {
        success: true,
        message: formatUiText(uiText.voiceControl.alreadyWithAgent, { agentName }),
      };
    }

    schedulePostToolAction(() => {
      disconnectFromRealtime();
      setSelectedAgentName(agentName);
      pendingVoiceReconnectRef.current = true;
    });
    return {
      success: true,
      message: formatUiText(uiText.voiceControl.switchingAgent, { agentName }),
    };
  }, [addTranscriptBreadcrumb, disconnectFromRealtime, schedulePostToolAction, selectedAgentConfigSet, selectedAgentName]);

  const handleVoiceControlDirective = useCallback(
    (directive: VoiceControlDirective) => {
      if (!directive) return;
      if (directive.action === 'switchScenario') {
        void requestScenarioChange(directive.scenarioKey, { initialCommand: directive.initialCommand });
      } else if (directive.action === 'switchAgent') {
        void requestAgentChange(directive.agentName);
      }
    },
    [requestAgentChange, requestScenarioChange],
  );

  const {
    connect,
    disconnect,
    sendUserText,
    sendEvent,
    interrupt,
    mute,
    sendAudioChunk,
    sendImage,
  } = useRealtimeSession(
    {
      onConnectionChange: (s) => setSessionStatus(s as SessionStatus),
      onAgentHandoff: (agentName: string) => {
        handoffTriggeredRef.current = true;
        setSelectedAgentName(agentName);
      },
      onVoiceControlDirective: handleVoiceControlDirective,
      onReady: () => setIsSessionReady(true),
    },
    {},
    { defaultCapabilities: { images: true } },
  );

  useEffect(() => {
    sendUserTextRef.current = sendUserText;
  }, [sendUserText]);

  const connectToRealtime = useCallback(async (source: "auto" | "manual" = "manual") => {
    if (!allAgentSets[agentSetKey]) {
      return;
    }

    if (sessionStatus === "CONNECTED" || sessionStatus === "CONNECTING") {
      console.info(
        "[connectToRealtime] ignored because status=%s (source=%s)",
        sessionStatus,
        source,
      );
      return;
    }

    try {
      setSessionError(null);
      initialResponseTriggeredRef.current = false;
      const normalizedAgentKey = normalizeScenarioKey(agentSetKey);
      const sessionInfo = await connect({
        agentSetKey,
        preferredAgentName: selectedAgentName,
        extraContext: {
          addTranscriptBreadcrumb,
          requestScenarioChange,
          requestAgentChange,
          logClientEvent,
        },
        clientCapabilities: { outputText: isTextOutputEnabled },
        clientTag: clientTag?.trim() || undefined,
      });
      const resolvedMemoryKey = sessionInfo?.memoryKey ?? normalizedAgentKey;
      setActiveMemoryKey(resolvedMemoryKey);
      setMemoryKeysByScenario((prev) => ({
        ...prev,
        [normalizedAgentKey]: resolvedMemoryKey,
      }));
    } catch (err) {
      console.error("Error connecting via SDK:", err);
      setSessionStatus("DISCONNECTED");
      setSessionError((err as Error)?.message ?? 'Failed to connect to session API');
    }
  }, [addTranscriptBreadcrumb, agentSetKey, clientTag, connect, isTextOutputEnabled, logClientEvent, requestAgentChange, requestScenarioChange, selectedAgentName, sessionStatus]);

  const handleSpeechDetected = useCallback(() => {
    if (isBargeInDisabled) {
      return;
    }
    logClientEvent(
      { type: 'barge_in_interrupt_sent' },
      'barge_in_interrupt',
    );
    interrupt();
  }, [interrupt, isBargeInDisabled, logClientEvent]);

  useMicrophoneStream({
    sessionStatus,
    sendAudioChunk,
    logClientEvent,
    speechDetectionEnabled: !isPTTActive && !isBargeInDisabled,
    onSpeechDetected: handleSpeechDetected,
  });

  useEffect(() => {
    if (pendingVoiceReconnectRef.current && sessionStatus === 'DISCONNECTED') {
      connectToRealtime('auto');
    }
  }, [connectToRealtime, sessionStatus]);

  useEffect(() => {
    if (pendingVoiceReconnectRef.current && sessionStatus === 'CONNECTED') {
      pendingVoiceReconnectRef.current = false;
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== 'CONNECTED') {
      setIsSessionReady(false);
    }
  }, [sessionStatus]);

  useEffect(() => {
    if (
      sessionStatus === 'CONNECTED' &&
      isSessionReady &&
      pendingInitialCommandRef.current
    ) {
      const initialCommand = pendingInitialCommandRef.current;
      pendingInitialCommandRef.current = null;
      sendUserText(initialCommand);
    }
  }, [isSessionReady, sessionStatus, sendUserText]);

  // セッション切断時のシナリオリセットは、音声のシナリオ切替による再接続を邪魔しないよう
  // pendingVoiceReconnectRef が立っていない場合のみ行う
  useEffect(() => {
    if (sessionStatus === 'DISCONNECTED' && !pendingVoiceReconnectRef.current) {
      setAgentSetKey(defaultAgentSetKey);
      setActiveMemoryKey(null);
    }
  }, [sessionStatus]);

  const updateSession = (shouldTriggerResponse: boolean = false) => {
    if (sessionStatus !== 'CONNECTED') {
      return;
    }
    // Reflect Push-to-Talk UI state by toggling server-side VAD via a minimal session.update.
    // We keep the payload scoped to the audio block so the agent instructions remain intact.
    const serverVadConfig = isPTTActive
      ? null
      : {
          ...SERVER_VAD_TEMPLATE,
          create_response: false,
        };

    sendEvent({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: serverVadConfig,
          },
        },
      },
    });

    if (shouldTriggerResponse) {
      // Auto-trigger without sending a synthetic user utterance.
      sendClientEvent({ type: 'response.create' }, 'initial response trigger');
    }
    return;
  }

  const handleSendTextMessage = () => {
    if (!userText.trim()) return;
    interrupt();

    try {
      sendUserText(userText.trim());
    } catch (err) {
      console.error('Failed to send via SDK', err);
    }

    setUserText("");
  };

  const handleSendImage = useCallback(
    async (file: File, caption?: string, triggerResponse = true) => {
      if (sessionStatus !== 'CONNECTED') {
        setSessionError('画像を送信するには先に接続してください');
        return;
      }
      addTranscriptBreadcrumb('Image upload', {
        name: file.name,
        size: file.size,
        type: file.type,
        caption: caption ?? '',
      });
      try {
        await sendImage(file, caption ? { text: caption, triggerResponse } : { triggerResponse });
      } catch (error) {
        console.error('Failed to send image', error);
        setSessionError('画像の送信に失敗しました。ログを確認してください。');
      }
    },
    [addTranscriptBreadcrumb, sendImage, sessionStatus],
  );

  const handleTalkButtonDown = () => {
    if (sessionStatus !== 'CONNECTED') return;
    interrupt();

    setIsPTTUserSpeaking(true);
    sendClientEvent({ type: 'input_audio_buffer.clear' }, 'clear PTT buffer');

    // No placeholder; we'll rely on server transcript once ready.
  };

  const handleTalkButtonUp = () => {
    if (sessionStatus !== 'CONNECTED' || !isPTTUserSpeaking)
      return;

    setIsPTTUserSpeaking(false);
    sendClientEvent({ type: 'input_audio_buffer.commit' }, 'commit PTT');
    sendClientEvent({ type: 'response.create' }, 'trigger response PTT');
  };

  const onToggleConnection = () => {
    if (sessionStatus === "CONNECTED") {
      disconnectFromRealtime();
      return;
    }

    if (sessionStatus === "CONNECTING") {
      console.info("[App] Connect request ignored because a connection is already in progress");
      return;
    }

    connectToRealtime();
  };

  const handleAgentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newAgentConfig = e.target.value;
    if (!allAgentSets[newAgentConfig]) return;

    pendingVoiceReconnectRef.current = true;
    disconnectFromRealtime();
    setAgentSetKey(newAgentConfig);
  };

  const handleSelectedAgentChange = (
    e: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newAgentName = e.target.value;
    // Reconnect session with the newly selected agent as root so that tool
    // execution works correctly.
    pendingVoiceReconnectRef.current = true;
    disconnectFromRealtime();
    setSelectedAgentName(newAgentName);
    // connectToRealtime will be triggered by effect watching selectedAgentName
  };

  // Because we need a new connection, refresh the page when codec changes
  const handleCodecChange = (newCodec: string) => {
    const url = new URL(window.location.toString());
    url.searchParams.set("codec", newCodec);
    window.location.replace(url.toString());
  };

  const handleResetMemory = useCallback(async () => {
    setIsResettingMemory(true);
    const normalizedKey = normalizeScenarioKey(agentSetKey);
    const storedKey = memoryKeysByScenario[normalizedKey] ?? activeMemoryKey ?? null;
    const requestBody: Record<string, string> = { agentSetKey: normalizedKey };
    if (storedKey) {
      requestBody.memoryKey = storedKey;
    }
    if (clientTag?.trim()) {
      requestBody.clientTag = clientTag.trim();
    }
    try {
      const response = await fetch('/api/memory', {
        method: 'DELETE',
        headers: buildBffHeaders(),
        body: JSON.stringify(requestBody),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = payload?.message ?? payload?.error ?? 'unknown';
        throw new Error(reason);
      }
      const resolvedMemoryKey =
        typeof payload?.memoryKey === 'string' ? payload.memoryKey : requestBody.memoryKey;
      if (resolvedMemoryKey) {
        setMemoryKeysByScenario((prev) => ({
          ...prev,
          [normalizedKey]: resolvedMemoryKey,
        }));
      }
      addTranscriptBreadcrumb(uiText.memory.resetDoneBreadcrumb, {
        agentSetKey: normalizedKey,
        memoryKey: resolvedMemoryKey ?? requestBody.memoryKey ?? 'unknown',
      });
      setSessionError(null);
      setActiveMemoryKey(null);
      setMemoryKeysByScenario((prev) => {
        const next = { ...prev };
        delete next[normalizedKey];
        return next;
      });
      // リセット直後はセッションを切断し、次回接続を完全に空の状態で開始させる
      disconnectFromRealtime();
    } catch (error) {
      const message = (error as Error)?.message ?? 'unknown';
      setSessionError(`${uiText.memory.resetFailedPrefix}${message}`);
    } finally {
      setIsResettingMemory(false);
    }
  }, [
    activeMemoryKey,
    addTranscriptBreadcrumb,
    agentSetKey,
    memoryKeysByScenario,
    disconnectFromRealtime,
    uiText.memory.resetDoneBreadcrumb,
    uiText.memory.resetFailedPrefix,
  ]);

  useEffect(() => {
    const storedPushToTalkUI = localStorage.getItem("pushToTalkUI");
    if (storedPushToTalkUI) {
      setIsPTTActive(storedPushToTalkUI === "true");
    }
    const storedLogsExpanded = localStorage.getItem("logsExpanded");
    if (storedLogsExpanded) {
      setIsEventsPaneExpanded(storedLogsExpanded === "true");
    }
    const storedAudioPlaybackEnabled = localStorage.getItem(
      "audioPlaybackEnabled"
    );
    if (storedAudioPlaybackEnabled) {
      setIsAudioPlaybackEnabled(storedAudioPlaybackEnabled === "true");
    }
    const storedBargeInDisabled = localStorage.getItem('bargeInDisabled');
    if (storedBargeInDisabled) {
      setIsBargeInDisabled(storedBargeInDisabled === 'true');
    }
    const storedTextOutputEnabled = localStorage.getItem('textOutputEnabled');
    if (storedTextOutputEnabled) {
      setIsTextOutputEnabled(storedTextOutputEnabled === 'true');
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("pushToTalkUI", isPTTActive.toString());
  }, [isPTTActive]);

  useEffect(() => {
    localStorage.setItem("logsExpanded", isEventsPaneExpanded.toString());
  }, [isEventsPaneExpanded]);

  useEffect(() => {
    localStorage.setItem(
      "audioPlaybackEnabled",
      isAudioPlaybackEnabled.toString()
    );
  }, [isAudioPlaybackEnabled]);

  useEffect(() => {
    localStorage.setItem('bargeInDisabled', isBargeInDisabled.toString());
  }, [isBargeInDisabled]);

  useEffect(() => {
    localStorage.setItem('textOutputEnabled', isTextOutputEnabled.toString());
  }, [isTextOutputEnabled]);

  useEffect(() => {
    localStorage.setItem('clientTag', clientTag);
  }, [clientTag]);

  useEffect(() => {
    mute(!isAudioPlaybackEnabled);
  }, [isAudioPlaybackEnabled, mute]);

  // Ensure mute state is propagated to transport right after we connect or
  // whenever the SDK client reference becomes available.
  useEffect(() => {
    if (sessionStatus === 'CONNECTED') {
      mute(!isAudioPlaybackEnabled);
    }
  }, [sessionStatus, isAudioPlaybackEnabled, mute]);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  return (
    <div className="text-base flex flex-col h-screen overflow-hidden bg-gradient-to-br from-amber-900 via-slate-900 to-emerald-950 text-white relative">
      <div className="p-5 text-lg font-semibold flex justify-between items-center">
        <div
          className="flex items-center cursor-pointer"
          onClick={() => window.location.reload()}
        >
          <div>
            <Image
              src="/openai-logomark.svg"
              alt={uiText.header.logoAlt}
              width={20}
              height={20}
              className="mr-2"
            />
          </div>
          <div>
            {uiText.header.titleMain}{" "}
            <span className="text-gray-500">{uiText.header.titleAccent}</span>
          </div>
        </div>
        <div className="flex items-center">
          <label className="flex items-center text-base gap-1 mr-2 font-medium">
            {uiText.header.scenarioLabel}
          </label>
          <div className="relative inline-block">
            <select
              value={agentSetKey}
              onChange={handleAgentChange}
              className="appearance-none border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
            >
              {Object.keys(allAgentSets).map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {agentSetMetadata[agentKey]?.label ?? agentKey}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          {agentSetKey && (
            <div className="flex items-center ml-6">
              <label className="flex items-center text-base gap-1 mr-2 font-medium">
                {uiText.header.agentLabel}
              </label>
              <div className="relative inline-block">
                <select
                  value={selectedAgentName}
                  onChange={handleSelectedAgentChange}
                  className="appearance-none border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] rounded-lg text-base px-2 py-1 pr-8 cursor-pointer font-normal focus:outline-none"
                >
                  {selectedAgentConfigSet?.map((agent) => (
                    <option key={agent.name} value={agent.name}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-600">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 10.44l3.71-3.21a.75.75 0 111.04 1.08l-4.25 3.65a.75.75 0 01-1.04 0L5.21 8.27a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center ml-6">
            <label className="flex items-center text-base gap-1 mr-2 font-medium">
              クライアントタグ
            </label>
            <input
              value={clientTag}
              onChange={(e) => setClientTag(e.target.value)}
              placeholder="develop / glasses01 / glasses02"
              className="border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] rounded-lg text-base px-2 py-1 w-36 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
            />
          </div>

          <button
            onClick={handleResetMemory}
            disabled={isResettingMemory}
            className="ml-6 px-3 py-1.5 text-sm rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-muted)] disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {isResettingMemory ? uiText.memory.resettingLabel : uiText.memory.resetLabel}
          </button>
        </div>
      </div>
      {sessionError && (
        <div className="mx-5 -mt-3 mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {formatUiText(uiText.session.errorMessageTemplate, {
            error: sessionError,
          })}
        </div>
      )}

      <div className="flex flex-1 gap-2 px-2 overflow-hidden relative">
        <div className="flex flex-col flex-1 gap-2">
          <CameraCapturePanel
            onSend={async (file, options) =>
              handleSendImage(file, undefined, options?.triggerResponse ?? true)
            }
            disabled={sessionStatus !== "CONNECTED"}
          />
          <ImageUploadPanel
            onSend={handleSendImage}
            disabled={sessionStatus !== "CONNECTED"}
          />
          <Transcript
            userText={userText}
            setUserText={setUserText}
            onSendMessage={handleSendTextMessage}
            downloadRecording={downloadRecording}
            canSend={
              sessionStatus === "CONNECTED"
            }
          />
        </div>

        <Events isExpanded={isEventsPaneExpanded} />
      </div>

      <BottomToolbar
        sessionStatus={sessionStatus}
        onToggleConnection={onToggleConnection}
        isPTTActive={isPTTActive}
        setIsPTTActive={setIsPTTActive}
        isPTTUserSpeaking={isPTTUserSpeaking}
        handleTalkButtonDown={handleTalkButtonDown}
        handleTalkButtonUp={handleTalkButtonUp}
        isEventsPaneExpanded={isEventsPaneExpanded}
        setIsEventsPaneExpanded={setIsEventsPaneExpanded}
        isAudioPlaybackEnabled={isAudioPlaybackEnabled}
        setIsAudioPlaybackEnabled={setIsAudioPlaybackEnabled}
        isBargeInDisabled={isBargeInDisabled}
        setIsBargeInDisabled={setIsBargeInDisabled}
        isTextOutputEnabled={isTextOutputEnabled}
        onTextOutputToggle={handleTextOutputPreferenceChange}
        codec={urlCodec}
        onCodecChange={handleCodecChange}
      />
    </div>
  );
}

export default App;
