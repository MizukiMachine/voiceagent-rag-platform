import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  HotwordListener,
  type HotwordDictionary,
  type HotwordMatch,
  type HotwordDetection,
  type HotwordLlmClassifier,
} from '../HotwordListener';

const baseDictionary: HotwordDictionary = {
  entries: [
    { scenarioKey: 'graffity', aliases: ['graffity', 'グラフィティ'] },
  ],
};

describe('HotwordListener', () => {
  let matches: HotwordMatch[];
  let detections: HotwordDetection[];
  let invalidItemIds: string[];
  let timeoutTriggered: boolean;
  let now: number;

  beforeEach(() => {
    matches = [];
    detections = [];
    invalidItemIds = [];
    timeoutTriggered = false;
    now = 0;
  });

  const buildListener = (override: Partial<ConstructorParameters<typeof HotwordListener>[0]> = {}) =>
    new HotwordListener({
      dictionary: baseDictionary,
      reminderTimeoutMs: 5000,
      clock: () => now,
      onMatch: (match) => matches.push(match),
      onDetection: (payload) => detections.push(payload),
      onInvalidTranscript: (payload) => invalidItemIds.push(payload.itemId),
      onTimeout: () => {
        timeoutTriggered = true;
      },
      ...override,
    });

  const completedEvent = (itemId: string, transcript: string) => ({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript,
  });

  const deltaEvent = (itemId: string, delta: string) => ({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: itemId,
    delta,
  });

  it('matches without the Hey prefix when requirePrefix is false', () => {
    const listener = buildListener({ requirePrefix: false });

    listener.handleTranscriptionEvent(completedEvent('msg_np', 'グラフィティ 今日の予定')); // no Hey

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      scenarioKey: 'graffity',
      commandText: '今日の予定',
    });
  });

  it('detects a hotword and extracts the scenario key and command text', () => {
    const listener = buildListener();
    listener.handleTranscriptionEvent(completedEvent('msg_1', 'Hey Graffity, play my playlist'));

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(
      expect.objectContaining({
        scenarioKey: 'graffity',
        commandText: 'play my playlist',
        itemId: 'msg_1',
      }),
    );
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ scenarioKey: 'graffity', stage: 'completed' });
    expect(invalidItemIds).toHaveLength(0);
  });

  it('emits onDetection as soon as a delta transcript contains the hotword prefix', () => {
    const listener = buildListener();

    listener.handleTranscriptionEvent(deltaEvent('msg_delta', 'Hey Gra'));
    expect(detections).toHaveLength(0);

    listener.handleTranscriptionEvent(deltaEvent('msg_delta', 'ffity,'));
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      scenarioKey: 'graffity',
      itemId: 'msg_delta',
      stage: 'delta',
    });

    listener.handleTranscriptionEvent(deltaEvent('msg_delta', ' what can you do?'));
    expect(detections).toHaveLength(1);
  });

  it('marks transcripts without hotwords as invalid and triggers timeout only once', () => {
    const listener = buildListener();

    listener.handleTranscriptionEvent(completedEvent('msg_3', 'Can you help me?'));
    expect(matches).toHaveLength(0);
    expect(invalidItemIds).toEqual(['msg_3']);
    expect(timeoutTriggered).toBe(false);

    now += 6000;
    listener.handleTranscriptionEvent(completedEvent('msg_4', 'Still no hotword here'));
    expect(timeoutTriggered).toBe(true);

    now += 6000;
    listener.handleTranscriptionEvent(completedEvent('msg_5', 'Another attempt without prefix'));
    expect(timeoutTriggered).toBe(true);
    expect(invalidItemIds).toEqual(['msg_3', 'msg_4', 'msg_5']);
  });

  it('resets timeout window after a successful hotword match', () => {
    const listener = buildListener();

    listener.handleTranscriptionEvent(completedEvent('msg_6', 'No wake phrase'));
    now += 6000;
    listener.handleTranscriptionEvent(completedEvent('msg_7', 'Hey Graffity, open calendar'));
    expect(timeoutTriggered).toBe(false);
    expect(matches).toHaveLength(1);

    now += 6000;
    listener.handleTranscriptionEvent(completedEvent('msg_8', 'Missing prefix again'));
    expect(timeoutTriggered).toBe(false);
  });

  it('falls back to detection on completed transcripts when no delta was seen', () => {
    const listener = buildListener();

    listener.handleTranscriptionEvent(completedEvent('msg_full', 'Hey Graffity, hello'));
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ itemId: 'msg_full', stage: 'completed' });
  });

  it('ignores non-transcription transport events', () => {
    const listener = buildListener();

    listener.handleTranscriptionEvent({
      type: 'response.output_audio.delta',
      delta: 'PCM',
    } as any);

    expect(matches).toHaveLength(0);
    expect(invalidItemIds).toHaveLength(0);
    expect(detections).toHaveLength(0);
  });
});
