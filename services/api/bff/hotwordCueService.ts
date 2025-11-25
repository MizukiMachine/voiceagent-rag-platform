import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '../../../framework/logging/structuredLogger';
import type { MetricEmitter } from '../../../framework/metrics/metricEmitter';

export interface HotwordCueRequest {
  sessionId: string;
  scenarioKey: string;
  transcript: string;
}

export interface HotwordCueResult {
  cueId: string;
  status: 'streamed' | 'fallback';
  reason?: string;
  audio?: string;
}

export interface HotwordCueService {
  playCue(request: HotwordCueRequest): Promise<HotwordCueResult>;
}

interface HotwordCueServiceOptions {
  audioFilePath?: string;
  logger: StructuredLogger;
  metrics: MetricEmitter;
}

export class ServerHotwordCueService implements HotwordCueService {
  private readonly logger: StructuredLogger;
  private readonly metrics: MetricEmitter;
  private readonly audioFilePath: string;
  private audioBase64?: string;

  constructor(options: HotwordCueServiceOptions) {
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.audioFilePath =
      options.audioFilePath ??
      path.join(
        process.cwd(),
        'public',
        'audio',
        '4-ESM_Airy_Echo_Metallic_Alert_Notification_Synth_Electronic_Particle_Cute_Cartoon.wav',
      );
  }

  async playCue(request: HotwordCueRequest): Promise<HotwordCueResult> {
    const cueId = `cue_${randomUUID()}`;
    try {
      const audio = this.loadAudioBase64();
      this.metrics.increment('bff.session.hotword_cue_emitted_total', 1, {
        scenario: request.scenarioKey,
      });
      return { cueId, status: 'streamed', audio };
    } catch (error) {
      this.logger.warn('Failed to emit hotword cue', {
        sessionId: request.sessionId,
        scenarioKey: request.scenarioKey,
        error,
      });
      this.metrics.increment('bff.session.hotword_cue_failed_total', 1, {
        scenario: request.scenarioKey,
      });
      return {
        cueId,
        status: 'fallback',
        reason: error instanceof Error ? error.message : 'Unknown hotword cue error',
      };
    }
  }

  private loadAudioBase64(): string {
    if (this.audioBase64) {
      return this.audioBase64;
    }
    const buffer = fs.readFileSync(this.audioFilePath);
    this.audioBase64 = buffer.toString('base64'); // WAVヘッダごと保持し、再生側でサンプルレートを尊重する
    return this.audioBase64;
  }
}
