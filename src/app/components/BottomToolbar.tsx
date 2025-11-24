import React from "react";
import { SessionStatus } from "@/app/types";
import { uiText } from "../i18n";

interface BottomToolbarProps {
  sessionStatus: SessionStatus;
  onToggleConnection: () => void;
  isPTTActive: boolean;
  setIsPTTActive: (val: boolean) => void;
  isPTTUserSpeaking: boolean;
  handleTalkButtonDown: () => void;
  handleTalkButtonUp: () => void;
  isEventsPaneExpanded: boolean;
  setIsEventsPaneExpanded: (val: boolean) => void;
  isAudioPlaybackEnabled: boolean;
  setIsAudioPlaybackEnabled: (val: boolean) => void;
  isBargeInDisabled: boolean;
  setIsBargeInDisabled: (val: boolean) => void;
  isTextOutputEnabled: boolean;
  onTextOutputToggle: (val: boolean) => void;
  codec: string;
  onCodecChange: (newCodec: string) => void;
}

function BottomToolbar({
  sessionStatus,
  onToggleConnection,
  isPTTActive,
  setIsPTTActive,
  isPTTUserSpeaking,
  handleTalkButtonDown,
  handleTalkButtonUp,
  isEventsPaneExpanded,
  setIsEventsPaneExpanded,
  isAudioPlaybackEnabled,
  setIsAudioPlaybackEnabled,
  isBargeInDisabled,
  setIsBargeInDisabled,
  isTextOutputEnabled,
  onTextOutputToggle,
  codec,
  onCodecChange,
}: BottomToolbarProps) {
  const isConnected = sessionStatus === "CONNECTED";
  const isConnecting = sessionStatus === "CONNECTING";
  const showPushToTalkControls = false;
  const showCodecSelector = false;

  const handleCodecChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newCodec = e.target.value;
    onCodecChange(newCodec);
  };

  function getConnectionButtonLabel() {
    if (isConnected) return uiText.toolbar.disconnectLabel;
    if (isConnecting) return uiText.toolbar.connectingLabel;
    return uiText.toolbar.connectLabel;
  }

  function getConnectionButtonClasses() {
    const baseClasses =
      "text-white text-base p-2 w-36 rounded-md h-full disabled:opacity-60 disabled:cursor-not-allowed";
    const cursorClass = isConnecting ? "cursor-progress" : "cursor-pointer";

    if (isConnected) {
      // Connected -> label "Disconnect" -> red
      return `bg-red-600 hover:bg-red-700 ${cursorClass} ${baseClasses}`;
    }
    // Disconnected or connecting -> label is either "Connect" or "Connecting" -> black
    return `bg-black hover:bg-gray-900 ${cursorClass} ${baseClasses}`;
  }

  return (
    <div className="p-4 flex flex-row items-center justify-center gap-x-8 bg-[var(--surface)] text-[var(--foreground)] border-t border-[var(--border)]">
      <button
        onClick={onToggleConnection}
        className={getConnectionButtonClasses()}
        disabled={isConnecting}
        aria-busy={isConnecting}
        aria-live="polite"
      >
        {getConnectionButtonLabel()}
      </button>

      {showPushToTalkControls && (
        <div className="flex flex-row items-center gap-2">
          <input
            id="push-to-talk"
            type="checkbox"
            checked={isPTTActive}
            onChange={(e) => setIsPTTActive(e.target.checked)}
            disabled={!isConnected}
            className="w-4 h-4"
          />
          <label
            htmlFor="push-to-talk"
            className="flex items-center cursor-pointer"
          >
            {uiText.toolbar.pushToTalkLabel}
          </label>
          <button
            onMouseDown={handleTalkButtonDown}
            onMouseUp={handleTalkButtonUp}
            onTouchStart={handleTalkButtonDown}
            onTouchEnd={handleTalkButtonUp}
            disabled={!isPTTActive}
            className={
              (isPTTUserSpeaking ? "bg-[var(--surface-muted)]" : "bg-[var(--surface)]") +
              " py-1 px-4 cursor-pointer rounded-md border border-[var(--border)] text-[var(--foreground)]" +
              (!isPTTActive ? " opacity-70" : "")
            }
          >
            {uiText.toolbar.talkButtonLabel}
          </button>
        </div>
      )}

      <div className="flex flex-row items-center gap-1">
        <input
          id="audio-playback"
          type="checkbox"
          checked={isAudioPlaybackEnabled}
          onChange={(e) => setIsAudioPlaybackEnabled(e.target.checked)}
          disabled={!isConnected}
          className="w-4 h-4"
        />
        <label
          htmlFor="audio-playback"
          className="flex items-center cursor-pointer"
        >
          {uiText.toolbar.audioPlaybackLabel}
        </label>
      </div>

      <div className="flex flex-row items-center gap-1">
        <input
          id="barge-in-disabled"
          type="checkbox"
          checked={isBargeInDisabled}
          onChange={(e) => setIsBargeInDisabled(e.target.checked)}
          disabled={!isConnected}
          className="w-4 h-4"
        />
        <label
          htmlFor="barge-in-disabled"
          className="flex items-center cursor-pointer"
        >
          {uiText.toolbar.bargeInDisableLabel}
        </label>
      </div>

      <div className="flex flex-row items-center gap-1">
        <input
          id="text-output"
          type="checkbox"
          checked={isTextOutputEnabled}
          onChange={(e) => onTextOutputToggle(e.target.checked)}
          disabled={!isConnected}
          className="w-4 h-4"
        />
        <label htmlFor="text-output" className="flex items-center cursor-pointer">
          {uiText.toolbar.textOutputLabel}
        </label>
      </div>

      <div className="flex flex-row items-center gap-2">
        <input
          id="logs"
          type="checkbox"
          checked={isEventsPaneExpanded}
          onChange={(e) => setIsEventsPaneExpanded(e.target.checked)}
          className="w-4 h-4"
        />
        <label htmlFor="logs" className="flex items-center cursor-pointer">
          {uiText.toolbar.logsLabel}
        </label>
      </div>

      {showCodecSelector && (
        <div className="flex flex-row items-center gap-2">
          <div>{uiText.toolbar.codecLabel}:</div>
          {/*
            Codec selector – Lets you force the WebRTC track to use 8 kHz 
            PCMU/PCMA so you can preview how the agent will sound 
            (and how ASR/VAD will perform) when accessed via a 
            phone network.  Selecting a codec reloads the page with ?codec=...
            which our App-level logic picks up and applies via a WebRTC monkey
            patch (see codecPatch.ts).
          */}
          <select
            id="codec-select"
            value={codec}
            onChange={handleCodecChange}
          className="border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] rounded-md px-2 py-1 focus:outline-none cursor-pointer"
        >
            <option value="opus">{uiText.toolbar.codecOptions.opus}</option>
            <option value="pcmu">{uiText.toolbar.codecOptions.pcmu}</option>
            <option value="pcma">{uiText.toolbar.codecOptions.pcma}</option>
          </select>
        </div>
      )}
    </div>
  );
}

export default BottomToolbar;
