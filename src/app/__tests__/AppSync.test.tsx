import React from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import App from "../App";
import { TranscriptProvider } from "../contexts/TranscriptContext";
import { EventProvider } from "../contexts/EventContext";
import { uiText } from "../i18n";

// --- Mocks ---------------------------------------------------------------
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("next/image", () => ({
  __esModule: true,
  default: (props: any) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} alt={props.alt} />;
  },
}));

vi.mock("../hooks/useMicrophoneStream", () => ({
  useMicrophoneStream: () => {},
}));

vi.mock("../hooks/useAudioDownload", () => ({
  __esModule: true,
  default: () => ({
    stopRecording: vi.fn(),
    downloadRecording: vi.fn(),
  }),
}));

vi.mock("../hooks/useHandleSessionHistory", () => ({
  useHandleSessionHistory: () => ({ current: {} }),
}));

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const sendUserTextMock = vi.fn();
const sendEventMock = vi.fn();
const interruptMock = vi.fn();
const muteMock = vi.fn();
const sendAudioChunkMock = vi.fn();
const sendImageMock = vi.fn();

let latestCallbacks: any = null;

vi.mock("../hooks/useRealtimeSession", () => ({
  useRealtimeSession: (callbacks: any) => {
    latestCallbacks = callbacks;
    connectMock.mockImplementation(() => {
      latestCallbacks?.onConnectionChange?.("CONNECTED");
    });
    disconnectMock.mockImplementation(() => {
      latestCallbacks?.onConnectionChange?.("DISCONNECTED");
    });

    return {
      connect: connectMock,
      disconnect: disconnectMock,
      sendUserText: sendUserTextMock,
      sendEvent: sendEventMock,
      interrupt: interruptMock,
      mute: muteMock,
      sendAudioChunk: sendAudioChunkMock,
      sendImage: sendImageMock,
    };
  },
}));

// ------------------------------------------------------------------------

function renderApp() {
  return render(
    <TranscriptProvider>
      <EventProvider>
        <App />
      </EventProvider>
    </TranscriptProvider>,
  );
}

describe("App scenario/agent synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects with the default scenario and keeps UI state", async () => {
    renderApp();

    const connectButton = screen.getByRole("button", {
      name: uiText.toolbar.connectLabel,
    });
    fireEvent.click(connectButton);

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));

    const scenarioSelect = screen.getAllByRole("combobox")[0];
    expect((scenarioSelect as HTMLSelectElement).value).toBe("graffity");
    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
