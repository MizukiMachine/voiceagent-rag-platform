import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ScenarioRouter } from '../ScenarioRouter';
import type { VoiceControlHandlers } from '../../../src/shared/voiceControl';
import type { HotwordMatch } from '../../../framework/voice_gateway/HotwordListener';

describe('ScenarioRouter', () => {
  const makeMatch = (overrides: Partial<HotwordMatch> = {}): HotwordMatch => ({
    scenarioKey: 'graffity',
    commandText: '注文状況を教えて',
    itemId: 'msg_a',
    transcript: 'Hey Graffity, 注文状況を教えて',
    ...overrides,
  });

  let voiceControl: VoiceControlHandlers;
  let forwarder: {
    replaceTranscriptWithText: ReturnType<typeof vi.fn>;
    interruptActiveResponse: ReturnType<typeof vi.fn>;
  };
  let router: ScenarioRouter;

  const createRouter = () =>
    new ScenarioRouter({
      currentScenarioKey: 'graffity',
      voiceControl,
      forwarder,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      mergeWindowMs: 20,
    });

  beforeEach(() => {
    voiceControl = {
      requestScenarioChange: vi.fn().mockResolvedValue({ success: true }),
      requestAgentChange: vi.fn().mockResolvedValue({ success: true }),
    } satisfies VoiceControlHandlers;

    forwarder = {
      replaceTranscriptWithText: vi.fn(),
      interruptActiveResponse: vi.fn(),
    };

    router = createRouter();
  });

  it('flushes the hotword command after the merge window elapses', async () => {
    vi.useFakeTimers();
    try {
      await router.handleHotwordMatch(makeMatch());
      expect(forwarder.replaceTranscriptWithText).not.toHaveBeenCalled();

      vi.advanceTimersByTime(25);
      await Promise.resolve();

      expect(forwarder.replaceTranscriptWithText).toHaveBeenCalledTimes(1);
      expect(forwarder.replaceTranscriptWithText).toHaveBeenCalledWith(makeMatch());
    } finally {
      vi.useRealTimers();
    }
  });

  it('appends continuation text arriving within the merge window', async () => {
    vi.useFakeTimers();
    try {
      const continuation = 'さらに教えてください';
      await router.handleHotwordMatch(makeMatch());
      vi.advanceTimersByTime(5);
      expect(router.appendContinuation(continuation)).toBe(true);

      vi.advanceTimersByTime(25);
      await Promise.resolve();

      expect(forwarder.replaceTranscriptWithText).toHaveBeenCalledTimes(1);
      expect(forwarder.replaceTranscriptWithText).toHaveBeenCalledWith(
        expect.objectContaining({
          commandText: `注文状況を教えて ${continuation}`,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests a scenario change when a different hotword arrives', async () => {
    const match = makeMatch({
      scenarioKey: 'kate',
      commandText: '今日の予定を教えて',
    });

    await router.handleHotwordMatch(match);

    expect(forwarder.replaceTranscriptWithText).not.toHaveBeenCalled();
    expect(forwarder.interruptActiveResponse).toHaveBeenCalledTimes(1);
    expect(voiceControl.requestScenarioChange).toHaveBeenCalledWith('kate', {
      initialCommand: '今日の予定を教えて',
    });
  });

  it('ignores empty hotword commands even when the scenario matches', async () => {
    await router.handleHotwordMatch(makeMatch({ commandText: '' }));

    expect(forwarder.replaceTranscriptWithText).not.toHaveBeenCalled();
    expect(voiceControl.requestScenarioChange).not.toHaveBeenCalled();
  });
});
