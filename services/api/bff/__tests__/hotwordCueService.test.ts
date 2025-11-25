/// <reference types="vitest" />
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerHotwordCueService, type HotwordCueRequest } from '../hotwordCueService';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  with: vi.fn(() => logger),
};

const metrics = {
  increment: vi.fn(),
  observe: vi.fn(),
};

describe('ServerHotwordCueService', () => {
  const audioPath = path.join(process.cwd(), 'public', 'audio', '4-ESM_Airy_Echo_Metallic_Alert_Notification_Synth_Electronic_Particle_Cute_Cartoon.wav');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const buildRequest = (overrides: Partial<HotwordCueRequest> = {}): HotwordCueRequest => ({
    sessionId: 'sess_test',
    scenarioKey: 'demo',
    transcript: 'Hey demo, 在庫を確認して',
    ...overrides,
  });

  it('returns a streamed cue with base64 audio when the asset exists', async () => {
    const service = new ServerHotwordCueService({
      audioFilePath: audioPath,
      logger,
      metrics,
    });

    const result = await service.playCue(buildRequest());

    expect(result.status).toBe('streamed');
    expect(result.audio).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(result.audio?.length ?? 0).toBeGreaterThan(100);
    expect(metrics.increment).toHaveBeenCalledWith(
      'bff.session.hotword_cue_emitted_total',
      1,
      expect.objectContaining({ scenario: 'demo' }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('falls back when the audio file is missing', async () => {
    const service = new ServerHotwordCueService({
      audioFilePath: path.join(process.cwd(), 'public', 'audio', 'missing.wav'),
      logger,
      metrics,
    });

    const result = await service.playCue(buildRequest());

    expect(result.status).toBe('fallback');
    expect(result.audio).toBeUndefined();
    expect(metrics.increment).toHaveBeenCalledWith(
      'bff.session.hotword_cue_failed_total',
      1,
      expect.objectContaining({ scenario: 'demo' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to emit hotword cue',
      expect.objectContaining({ sessionId: 'sess_test', scenarioKey: 'demo' }),
    );
  });
});
