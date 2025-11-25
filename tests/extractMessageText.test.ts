import { describe, expect, it } from "vitest";
import { extractMessageText, resolveFunctionCallName } from "@/app/hooks/useHandleSessionHistory";

describe("extractMessageText", () => {
  it("returns concatenated plain text for input_text chunks", () => {
    const text = extractMessageText([
      { type: "input_text", text: "Hello" },
      { type: "input_text", text: "World" },
    ]);
    expect(text).toBe("Hello\nWorld");
  });

  it("prefers transcripts for audio chunks", () => {
    const text = extractMessageText([
      { type: "audio", transcript: "spoken words" },
    ]);
    expect(text).toBe("spoken words");
  });

  it("supports output_audio transcripts emitted by the assistant", () => {
    const text = extractMessageText([
      { type: "output_audio", transcript: "assistant response" },
    ]);
    expect(text).toBe("assistant response");
  });

  it("reads output_text chunks when text modality is enabled", () => {
    const text = extractMessageText([
      { type: "output_text", text: "textual output" },
    ]);
    expect(text).toBe("textual output");
  });

  it("ignores unsupported chunks and filters empty strings", () => {
    const text = extractMessageText([
      { type: "output_audio", transcript: "" },
      { type: "unknown", foo: "bar" },
      { type: "audio", transcript: "kept" },
    ]);
    expect(text).toBe("kept");
  });
});

describe("resolveFunctionCallName", () => {
  it("returns undefined when functionCall is null", () => {
    expect(resolveFunctionCallName(null)).toBeUndefined();
  });

  it("returns undefined when name is missing", () => {
    expect(resolveFunctionCallName({})).toBeUndefined();
  });

  it("trims and returns the function name when present", () => {
    expect(resolveFunctionCallName({ name: "  foo " })).toBe("foo");
  });
});
