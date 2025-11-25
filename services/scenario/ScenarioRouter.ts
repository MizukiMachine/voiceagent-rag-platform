import type { HotwordMatch } from '../../framework/voice_gateway/HotwordListener';
import type { StructuredLogger } from '../../framework/logging/structuredLogger';
import type { VoiceControlHandlers } from '../../src/shared/voiceControl';

export interface ScenarioCommandForwarder {
  replaceTranscriptWithText: (match: HotwordMatch) => Promise<void> | void;
  interruptActiveResponse: () => Promise<void> | void;
}

export interface ScenarioRouterOptions {
  currentScenarioKey: string;
  voiceControl: VoiceControlHandlers;
  forwarder: ScenarioCommandForwarder;
  logger?: Pick<StructuredLogger, 'info' | 'warn' | 'error' | 'debug'>;
  minimumCommandLength?: number;
  mergeWindowMs?: number;
  scenarioSwitchDelayMs?: number;
}

interface PendingHotwordCommand {
  match: HotwordMatch;
  commandText: string;
  lastUpdatedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class ScenarioRouter {
  private currentScenarioKey: string;
  private readonly voiceControl: VoiceControlHandlers;
  private readonly forwarder: ScenarioCommandForwarder;
  private readonly logger?: ScenarioRouterOptions['logger'];
  private readonly minimumCommandLength: number;
  private readonly mergeWindowMs: number;
  private readonly scenarioSwitchDelayMs: number;
  private pendingHotwordCommand: PendingHotwordCommand | null = null;

  constructor(options: ScenarioRouterOptions) {
    this.currentScenarioKey = options.currentScenarioKey;
    this.voiceControl = options.voiceControl;
    this.forwarder = options.forwarder;
    this.logger = options.logger;
    this.minimumCommandLength = Math.max(options.minimumCommandLength ?? 1, 1);
    this.mergeWindowMs = Math.max(options.mergeWindowMs ?? 3000, 0);
    this.scenarioSwitchDelayMs = Math.max(options.scenarioSwitchDelayMs ?? 0, 0);
  }

  setCurrentScenarioKey(next: string): void {
    if (!next) return;
    this.currentScenarioKey = next;
  }

  async handleHotwordMatch(match: HotwordMatch): Promise<void> {
    await this.flushPendingCommand();

    const commandText = match.commandText.trim();
    if (!commandText || commandText.length < this.minimumCommandLength) {
      this.logger?.debug?.('Ignoring hotword without command body', {
        scenarioKey: match.scenarioKey,
        itemId: match.itemId,
      });
      return;
    }

    if (this.normalize(match.scenarioKey) === this.normalize(this.currentScenarioKey)) {
      this.startPendingCommand(match, commandText);
      return;
    }

    this.logger?.info?.('Hotword detected for different scenario. Requesting switch.', {
      currentScenario: this.currentScenarioKey,
      requestedScenario: match.scenarioKey,
      commandPreview: commandText.slice(0, 60),
    });
    if (this.scenarioSwitchDelayMs > 0) {
      await this.sleep(this.scenarioSwitchDelayMs);
    }
    await this.forwarder.interruptActiveResponse();
    await this.voiceControl.requestScenarioChange(match.scenarioKey, {
      initialCommand: commandText,
    });
    this.currentScenarioKey = match.scenarioKey;
  }

  appendContinuation(text: string): boolean {
    const trimmed = text?.trim();
    if (!trimmed) return false;
    const pending = this.pendingHotwordCommand;
    if (!pending) return false;
    const now = Date.now();
    if (now - pending.lastUpdatedAt > this.mergeWindowMs) {
      return false;
    }
    pending.commandText = this.mergeCommandTexts(pending.commandText, trimmed);
    pending.lastUpdatedAt = now;
    this.schedulePendingFlush();
    return true;
  }

  private startPendingCommand(match: HotwordMatch, commandText: string) {
    this.clearPendingTimer();
    this.pendingHotwordCommand = {
      match: { ...match },
      commandText,
      lastUpdatedAt: Date.now(),
    };
    this.schedulePendingFlush();
  }

  private schedulePendingFlush() {
    if (!this.pendingHotwordCommand) return;
    this.clearPendingTimer();
    this.pendingHotwordCommand.timer = setTimeout(() => {
      void this.flushPendingCommand().catch((error) => {
        this.logger?.error?.('Failed to flush aggregated hotword command', { error });
      });
    }, this.mergeWindowMs);
  }

  private async flushPendingCommand(): Promise<void> {
    const pending = this.pendingHotwordCommand;
    if (!pending) return;
    this.clearPendingTimer();
    this.pendingHotwordCommand = null;
    const aggregated = pending.commandText.trim();
    if (!aggregated) return;
    try {
      await this.forwarder.replaceTranscriptWithText({
        ...pending.match,
        commandText: aggregated,
      });
    } catch (error) {
      this.logger?.error?.('Failed to flush aggregated hotword command', { error });
    }
  }

  private clearPendingTimer() {
    if (!this.pendingHotwordCommand?.timer) return;
    clearTimeout(this.pendingHotwordCommand.timer);
    this.pendingHotwordCommand.timer = undefined;
  }

  private mergeCommandTexts(base: string, addition: string): string {
    if (!base) return addition;
    const needsSpace = !base.endsWith(' ') && !base.endsWith('\n');
    return needsSpace ? `${base} ${addition}` : `${base}${addition}`;
  }

  private normalize(value: string): string {
    return value?.trim().toLowerCase() ?? '';
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }
}
