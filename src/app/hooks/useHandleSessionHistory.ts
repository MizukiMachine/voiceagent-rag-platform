"use client";

import { useRef } from "react";
import { useTranscript } from "@/app/contexts/TranscriptContext";
import { useEvent } from "@/app/contexts/EventContext";
import type { TranscriptAttachment } from "@/app/types";

export const extractMessageText = (content: any[] = []): string => {
  if (!Array.isArray(content)) return "";

  const normalizeChunk = (chunk: any): string => {
    if (!chunk || typeof chunk !== "object") return "";
    const textValue =
      typeof chunk.text === "string"
        ? chunk.text
        : Array.isArray(chunk.text)
          ? chunk.text.join("")
          : undefined;

    switch (chunk.type) {
      case "input_text":
      case "output_text":
      case "text":
        return textValue ?? "";
      case "audio":
      case "input_audio_transcription":
      case "output_audio":
        return (
          (typeof chunk.transcript === "string" && chunk.transcript) ||
          textValue ||
          ""
        );
      default:
        if (typeof chunk.transcript === "string") {
          return chunk.transcript;
        }
        if (typeof chunk.content === "string") {
          return chunk.content;
        }
        return textValue ?? "";
    }
  };

  return content
    .map((chunk) => normalizeChunk(chunk))
    .filter((val) => typeof val === "string" && val.length > 0)
    .join("\n");
};

export const resolveFunctionCallName = (functionCall: any): string | undefined => {
  if (!functionCall) return undefined;
  const name = typeof functionCall?.name === 'string' ? functionCall.name.trim() : '';
  return name && name.length > 0 ? name : undefined;
};

const extractImageAttachments = (content: any[] = []): TranscriptAttachment[] => {
  if (!Array.isArray(content)) return [];
  return content
    .filter((chunk) => chunk?.type === 'input_image' && typeof chunk?.image === 'string')
    .map((chunk) => ({
      type: 'image',
      url: `data:${chunk?.mime_type ?? 'image/png'};base64,${chunk.image}`,
      mimeType: chunk?.mime_type ?? 'image/png',
      name: chunk?.name ?? undefined,
      size: typeof chunk?.size === 'number' ? chunk.size : undefined,
    }));
};

export function useHandleSessionHistory() {
  const {
    transcriptItems,
    addTranscriptBreadcrumb,
    addTranscriptMessage,
    updateTranscriptMessage,
    updateTranscriptItem,
  } = useTranscript();

  const { logServerEvent } = useEvent();

  // 直近数秒に同じテキストを重複表示しないための簡易デデュープバッファ
  const recentMessagesRef = useRef<Array<{ role: string; text: string; ts: number }>>([]);
  const isRecentDuplicate = (role: string, text: string, windowMs = 3000) => {
    const now = Date.now();
    recentMessagesRef.current = recentMessagesRef.current.filter((m) => now - m.ts <= windowMs);
    const hit = recentMessagesRef.current.find((m) => m.role === role && m.text === text);
    if (!hit) {
      recentMessagesRef.current.push({ role, text, ts: now });
      return false;
    }
    return true;
  };

  /* ----------------------- helpers ------------------------- */

  const extractFunctionCallByName = (name: string, content: any[] = []): any => {
    if (!Array.isArray(content)) return undefined;
    return content.find((c: any) => c.type === 'function_call' && c.name === name);
  };

  const maybeParseJson = (val: any) => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        console.warn('Failed to parse JSON:', val);
        return val;
      }
    }
    return val;
  };

  const extractLastAssistantMessage = (history: any[] = []): any => {
    if (!Array.isArray(history)) return undefined;
    return history.reverse().find((c: any) => c.type === 'message' && c.role === 'assistant');
  };

  const extractModeration = (obj: any) => {
    if ('moderationCategory' in obj) return obj;
    if ('outputInfo' in obj) return extractModeration(obj.outputInfo);
    if ('output' in obj) return extractModeration(obj.output);
    if ('result' in obj) return extractModeration(obj.result);
  };

  // Temporary helper until the guardrail_tripped event includes the itemId in the next version of the SDK
  const sketchilyDetectGuardrailMessage = (text: string) => {
    return text.match(/Failure Details: (\{.*?\})/)?.[1];
  };

  /* ----------------------- event handlers ------------------------- */

  function handleAgentToolStart(details: any, _agent: any, functionCall: any) {
    const functionName = resolveFunctionCallName(functionCall);
    if (!functionName) {
      console.warn('[handleAgentToolStart] missing function call metadata', { details });
      return;
    }
    const lastFunctionCall = extractFunctionCallByName(functionName, details?.context?.history);
    if (!lastFunctionCall) {
      console.warn('[handleAgentToolStart] unable to locate function call in history', {
        functionName,
      });
      return;
    }
    addTranscriptBreadcrumb(`function call: ${functionName}`, lastFunctionCall.arguments);
  }
  function handleAgentToolEnd(details: any, _agent: any, _functionCall: any, result: any) {
    const functionName = resolveFunctionCallName(_functionCall);
    if (!functionName) {
      console.warn('[handleAgentToolEnd] missing function call metadata', { details });
      return;
    }
    addTranscriptBreadcrumb(
      `function call result: ${functionName}`,
      maybeParseJson(result)
    );
  }

  function handleHistoryAdded(item: any) {
    console.log("[handleHistoryAdded] ", item);
    if (!item || item.type !== 'message') return;

    const { itemId, role, content = [] } = item;
    // 過去セッションのリプレイや guardrail 内部メッセージは表示しない
    if (item?.metadata?.source === 'persistent_memory') return;
    if (itemId && role) {
      const isUser = role === "user";
      let text = extractMessageText(content);
      const attachments = extractImageAttachments(content);

      if (isUser && !text) {
        text = attachments.length > 0 ? "[Image uploaded]" : "[Transcribing...]";
      }

      // If the guardrail has been tripped, this message is a message that gets sent to the 
      // assistant to correct it, so we add it as a breadcrumb instead of a message.
      const guardrailMessage = sketchilyDetectGuardrailMessage(text);
      if (guardrailMessage) {
        const failureDetails = JSON.parse(guardrailMessage);
        addTranscriptBreadcrumb('Output Guardrail Active', { details: failureDetails });
      } else {
        if (text && isRecentDuplicate(role, text)) return;
        addTranscriptMessage(itemId, role, text, false, attachments);
      }
    }
  }

  function handleHistoryUpdated(items: any[]) {
    console.log("[handleHistoryUpdated] ", items);
    items.forEach((item: any) => {
      if (!item || item.type !== 'message') return;
      if (item?.metadata?.source === 'persistent_memory') return;

      const { itemId, content = [] } = item;

      const text = extractMessageText(content);

      if (text) {
        if (isRecentDuplicate(item.role ?? 'assistant', text)) return;
        updateTranscriptMessage(itemId, text, false);
      }
    });
  }

  function handleTranscriptionDelta(item: any) {
    const itemId = item.item_id;
    const deltaText = item.delta || "";
    if (itemId) {
      // タイムスタンプが同じ複数行に見えるのを避けるため、途中経過のdeltaは
      // 既存テキストと結合しない（append=false で上書き）。
      updateTranscriptMessage(itemId, deltaText, false);
    }
  }

  function handleTranscriptionCompleted(item: any) {
    // History updates don't reliably end in a completed item, 
    // so we need to handle finishing up when the transcription is completed.
    const itemId = item.item_id;
    const finalTranscript =
        !item.transcript || item.transcript === "\n"
        ? "[inaudible]"
        : item.transcript;
    if (itemId) {
      updateTranscriptMessage(itemId, finalTranscript, false);
      // Use the ref to get the latest transcriptItems
      const transcriptItem = transcriptItems.find((i) => i.itemId === itemId);
      updateTranscriptItem(itemId, { status: 'DONE' });

      // If guardrailResult still pending, mark PASS.
      if (transcriptItem?.guardrailResult?.status === 'IN_PROGRESS') {
        updateTranscriptItem(itemId, {
          guardrailResult: {
            status: 'DONE',
            category: 'NONE',
            rationale: '',
          },
        });
      }
    }
  }

  function handleGuardrailTripped(details: any, _agent: any, guardrail: any) {
    console.log("[guardrail tripped]", details, _agent, guardrail);
    const moderation = extractModeration(guardrail.result.output.outputInfo);
    logServerEvent({ type: 'guardrail_tripped', payload: moderation });

    // find the last assistant message in details.context.history
    const lastAssistant = extractLastAssistantMessage(details?.context?.history);

    if (lastAssistant && moderation) {
      const category = moderation.moderationCategory ?? 'NONE';
      const rationale = moderation.moderationRationale ?? '';
      const offendingText: string | undefined = moderation?.testText;

      updateTranscriptItem(lastAssistant.itemId, {
        guardrailResult: {
          status: 'DONE',
          category,
          rationale,
          testText: offendingText,
        },
      });
    }
  }

  const handlersRef = useRef({
    handleAgentToolStart,
    handleAgentToolEnd,
    handleHistoryUpdated,
    handleHistoryAdded,
    handleTranscriptionDelta,
    handleTranscriptionCompleted,
    handleGuardrailTripped,
  });

  return handlersRef;
}
