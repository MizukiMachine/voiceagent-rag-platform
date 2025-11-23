const DEFAULT_HOTWORD_TIMEOUT_MS = 8000;
const HOTWORD_PREFIXES = [
  'hey',
  'ﾍｲ',
  'ヘイ',
  'へい',
  'はい',
  'ハイ',
  'ﾊｲ',
  'ねえ', 
  'へえ', 
  'Hej',
  'Hei',
  'Hi',
  'hi',
];
const DEFAULT_FILLERS = [
  'えー',
  'えっと',
  'ええと',
  'あの',
  'その',
  'はい',
  'うーん',
  'ねえ',
  'ねぇ',
  'あー',
  'あぁ',
  'おい',
  'もしもし',
  ...HOTWORD_PREFIXES,
];
const DEFAULT_LLM_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_FUZZY_DISTANCE_THRESHOLD = 2;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const HOTWORD_DELIMITER_PATTERN = '[\\s,、。!！?？:：;；-]*';
const LEADING_PUNCTUATION = /^[\s,、。!！?？:：;；-]+/u;

export interface HotwordDictionaryEntry {
  scenarioKey: string;
  aliases: string[];
}

export interface HotwordDictionary {
  entries: HotwordDictionaryEntry[];
}

export interface HotwordMatch {
  scenarioKey: string;
  commandText: string;
  itemId: string;
  transcript: string;
   confidence?: number;
   method?: 'prefix_regex' | 'alias_regex' | 'fuzzy' | 'llm';
}

export interface HotwordDetection {
  scenarioKey: string;
  itemId: string;
  transcript: string;
  stage: 'delta' | 'completed';
  confidence?: number;
  method?: HotwordMatch['method'];
}

interface AliasMatcher {
  scenarioKey: string;
  regexp: RegExp;
}

export interface LlmHotwordClassificationResult {
  scenarioKey: string | null;
  confidence: number;
  reason?: string;
  matchedAlias?: string;
}

export interface HotwordLlmClassifier {
  classify: (params: {
    transcript: string;
    dictionary: HotwordDictionary;
  }) => Promise<LlmHotwordClassificationResult | null>;
}

export interface HotwordListenerOptions {
  dictionary: HotwordDictionary;
  reminderTimeoutMs?: number;
  onMatch: (match: HotwordMatch) => void | Promise<void>;
  onDetection?: (payload: HotwordDetection) => void | Promise<void>;
  onInvalidTranscript?: (payload: { itemId: string; transcript: string }) => void;
  onTimeout?: () => void;
  clock?: () => number;
  requirePrefix?: boolean;
  minimumLlmConfidence?: number;
  minimumConfidence?: number;
  fuzzyDistanceThreshold?: number;
  llmClassifier?: HotwordLlmClassifier;
  fillers?: string[];
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeAlias(alias: string): string | null {
  const trimmed = alias?.trim();
  return trimmed?.length ? trimmed : null;
}

export class HotwordListener {
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private readonly matchers: AliasMatcher[];
  private readonly aliasOnlyMatchers: AliasMatcher[];
  private readonly onMatch: HotwordListenerOptions['onMatch'];
  private readonly onDetection?: HotwordListenerOptions['onDetection'];
  private readonly onInvalidTranscript?: HotwordListenerOptions['onInvalidTranscript'];
  private readonly onTimeout?: HotwordListenerOptions['onTimeout'];
  private readonly requirePrefix: boolean;
  private readonly minimumLlmConfidence: number;
  private readonly minimumConfidence: number;
  private readonly fuzzyDistanceThreshold: number;
  private readonly llmClassifier?: HotwordLlmClassifier;
  private readonly fillers: string[];

  private readonly dictionary: HotwordDictionary;
  private readonly llmInFlight = new Set<string>();

  private lastHotwordAt: number | null = null;
  private reminderSentAt: number | null = null;
  private readonly partialTranscripts = new Map<string, string>();
  private readonly detectedItems = new Set<string>();

  constructor(options: HotwordListenerOptions) {
    this.timeoutMs = Math.max(options.reminderTimeoutMs ?? DEFAULT_HOTWORD_TIMEOUT_MS, 1000);
    this.clock = options.clock ?? (() => Date.now());
    this.onMatch = options.onMatch;
    this.onDetection = options.onDetection;
    this.onInvalidTranscript = options.onInvalidTranscript;
    this.onTimeout = options.onTimeout;
    this.requirePrefix = options.requirePrefix ?? true;
    this.minimumLlmConfidence = options.minimumLlmConfidence ?? DEFAULT_LLM_CONFIDENCE_THRESHOLD;
    this.minimumConfidence = options.minimumConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.fuzzyDistanceThreshold = Math.max(options.fuzzyDistanceThreshold ?? DEFAULT_FUZZY_DISTANCE_THRESHOLD, 0);
    this.fillers = options.fillers ?? DEFAULT_FILLERS;
    this.llmClassifier = options.llmClassifier;
    this.dictionary = options.dictionary;
    this.matchers = this.buildMatchers(options.dictionary, true);
    this.aliasOnlyMatchers = this.buildMatchers(options.dictionary, false);
  }

  handleTranscriptionEvent(event: any): boolean {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return false;
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      return this.handleDeltaEvent(event);
    }

    if (event.type !== 'conversation.item.input_audio_transcription.completed') {
      return false;
    }

    const itemId = typeof event.item_id === 'string' ? event.item_id : '';
    const transcript = String(event.transcript ?? '').trim();
    const searchableTranscript = transcript || (this.partialTranscripts.get(itemId) ?? '').trim();
    if (!searchableTranscript) {
      this.cleanupItem(itemId);
      return true;
    }

    const matched = this.findHotwordMatch(searchableTranscript);

    if (matched) {
      const commandText = this.extractCommand(searchableTranscript, matched.consumedLength);
      if (!commandText) {
        this.onInvalidTranscript?.({ itemId, transcript: searchableTranscript });
        this.maybeTriggerTimeout();
        this.cleanupItem(itemId);
        return true;
      }
      this.emitDetection(itemId, matched.scenarioKey, searchableTranscript, 'completed', matched.method, matched.confidence);
      this.lastHotwordAt = null;
      this.reminderSentAt = null;
      void this.onMatch({
        scenarioKey: matched.scenarioKey,
        commandText,
        itemId,
        transcript: searchableTranscript,
        confidence: matched.confidence,
        method: matched.method,
      });
      this.cleanupItem(itemId);
      return true;
    }

    if (this.llmClassifier && !this.llmInFlight.has(itemId)) {
      void this.runLlmClassification(itemId, searchableTranscript);
    } else {
      this.onInvalidTranscript?.({ itemId, transcript: searchableTranscript });
      this.maybeTriggerTimeout();
      this.cleanupItem(itemId);
    }
    return true;
  }

  private handleDeltaEvent(event: any): boolean {
    const itemId = typeof event.item_id === 'string' ? event.item_id : '';
    if (!itemId) {
      return true;
    }
    const delta = this.extractDeltaText(event);
    if (!delta) {
      return true;
    }
    const nextTranscript = (this.partialTranscripts.get(itemId) ?? '') + delta;
    this.partialTranscripts.set(itemId, nextTranscript);
    const matched = this.findHotwordMatch(nextTranscript.trim());
    if (matched) {
      this.emitDetection(itemId, matched.scenarioKey, nextTranscript, 'delta', matched.method, matched.confidence);
    }
    return true;
  }

  private extractDeltaText(event: any): string {
    if (typeof event.delta === 'string') {
      return event.delta;
    }
    if (Array.isArray(event.delta)) {
      return event.delta.join('');
    }
    if (typeof event.transcript === 'string') {
      return event.transcript;
    }
    return '';
  }

  private extractCommand(transcript: string, consumedLength: number): string {
    const remainder = transcript.slice(consumedLength).replace(LEADING_PUNCTUATION, '').trim();
    return remainder;
  }

  private buildMatchers(dictionary: HotwordDictionary, withPrefix: boolean): AliasMatcher[] {
    const prefixPattern = `(?:${HOTWORD_PREFIXES.map(escapeForRegExp).join('|')})`;
    const matchers: AliasMatcher[] = [];
    for (const entry of dictionary.entries ?? []) {
      for (const alias of entry.aliases ?? []) {
        const normalizedAlias = sanitizeAlias(alias);
        if (!normalizedAlias) continue;
        const bodyPattern = `${HOTWORD_DELIMITER_PATTERN}(${escapeForRegExp(normalizedAlias)})`;
        const regexp = withPrefix
          ? new RegExp(`^\\s*${prefixPattern}${bodyPattern}`, 'iu')
          : new RegExp(`^\\s*${bodyPattern}`, 'iu');
        matchers.push({ scenarioKey: entry.scenarioKey, regexp });
      }
    }
    return matchers;
  }

  private findHotwordMatch(
    transcript: string,
  ):
    | { scenarioKey: string; consumedLength: number; method?: HotwordMatch['method']; confidence?: number }
    | null {
    const trimmed = transcript.trim();

    for (const matcher of this.matchers) {
      const result = trimmed.match(matcher.regexp);
      if (result && typeof result[0] === 'string') {
        const confidence = 1;
        if (confidence < this.minimumConfidence) continue;
        return {
          scenarioKey: matcher.scenarioKey,
          consumedLength: result[0].length,
          method: 'prefix_regex',
          confidence,
        };
      }
    }

    if (!this.requirePrefix) {
      const cleanedTranscript = this.stripFillers(trimmed);
      for (const matcher of this.aliasOnlyMatchers) {
        const result = cleanedTranscript.match(matcher.regexp);
        if (result && typeof result[0] === 'string') {
          const confidence = 0.95;
          if (confidence < this.minimumConfidence) continue;
          return {
            scenarioKey: matcher.scenarioKey,
            consumedLength: result[0].length,
            method: 'alias_regex',
            confidence,
          };
        }
      }

      const fuzzy = this.findFuzzyAliasMatch(cleanedTranscript);
      if (fuzzy && (fuzzy.confidence ?? 0) >= this.minimumConfidence) {
        return fuzzy;
      }
    }
    return null;
  }

  private stripFillers(text: string): string {
    let next = text?.trim() ?? '';
    if (!next) return next;
    const pattern = new RegExp(
      `^(${this.fillers.map((f) => escapeForRegExp(f)).join('|')})${HOTWORD_DELIMITER_PATTERN}`,
      'iu',
    );
    let replaced = next;
    // 繰り返し先頭のフィラーを除去
    do {
      next = replaced;
      replaced = next.replace(pattern, '').trim();
    } while (replaced !== next && replaced.length > 0);
    return next;
  }

  private findFuzzyAliasMatch(transcript: string):
    | ({ scenarioKey: string; consumedLength: number; method: HotwordMatch['method']; confidence: number })
    | null {
    const lowered = transcript.toLowerCase();
    for (const entry of this.dictionary.entries ?? []) {
      for (const alias of entry.aliases ?? []) {
        const normalizedAlias = sanitizeAlias(alias)?.toLowerCase();
        if (!normalizedAlias) continue;

        // 先頭付近での近似マッチのみを見る（暴走防止）
        const window = lowered.slice(0, Math.max(normalizedAlias.length + 6, 12));
        const distance = levenshtein(window.slice(0, normalizedAlias.length), normalizedAlias);
        if (distance <= this.fuzzyDistanceThreshold) {
          const confidence = Math.max(0, 1 - distance / Math.max(normalizedAlias.length, 1));
          return {
            scenarioKey: entry.scenarioKey,
            consumedLength: normalizedAlias.length,
            method: 'fuzzy',
            confidence,
          };
        }

        const index = lowered.indexOf(normalizedAlias);
        if (index >= 0 && index < 16) {
          return {
            scenarioKey: entry.scenarioKey,
            consumedLength: index + normalizedAlias.length,
            method: 'fuzzy',
            confidence: 0.9,
          };
        }
      }
    }
    return null;
  }

  private maybeTriggerTimeout(): void {
    const now = this.clock();
    if (this.lastHotwordAt === null) {
      this.lastHotwordAt = now;
      return;
    }
    if (this.reminderSentAt !== null) {
      return;
    }
    if (now - this.lastHotwordAt >= this.timeoutMs) {
      this.reminderSentAt = now;
      this.onTimeout?.();
    }
  }

  private emitDetection(
    itemId: string,
    scenarioKey: string,
    transcript: string,
    stage: HotwordDetection['stage'],
    method?: HotwordMatch['method'],
    confidence?: number,
  ): void {
    if (!this.onDetection || this.detectedItems.has(itemId)) {
      return;
    }
    this.detectedItems.add(itemId);
    void this.onDetection({ scenarioKey, itemId, transcript, stage, method, confidence });
  }

  private cleanupItem(itemId: string): void {
    if (!itemId) return;
    this.partialTranscripts.delete(itemId);
    this.detectedItems.delete(itemId);
    this.llmInFlight.delete(itemId);
  }

  private async runLlmClassification(itemId: string, transcript: string): Promise<void> {
    if (!this.llmClassifier) return;
    this.llmInFlight.add(itemId);
    try {
      const result = await this.llmClassifier.classify({ transcript, dictionary: this.dictionary });
      if (!result || !result.scenarioKey || result.confidence < this.minimumLlmConfidence) {
        this.onInvalidTranscript?.({ itemId, transcript });
        this.maybeTriggerTimeout();
        this.cleanupItem(itemId);
        return;
      }

      const aliasLength = this.resolveAliasLength(transcript, result.scenarioKey, result.matchedAlias);
      const consumedLength = aliasLength ?? result.matchedAlias?.length ?? 0;
      const commandText = this.extractCommand(transcript, consumedLength);
      if (!commandText) {
        this.onInvalidTranscript?.({ itemId, transcript });
        this.maybeTriggerTimeout();
        this.cleanupItem(itemId);
        return;
      }

      this.emitDetection(itemId, result.scenarioKey, transcript, 'completed', 'llm', result.confidence);
      this.lastHotwordAt = null;
      this.reminderSentAt = null;
      void this.onMatch({
        scenarioKey: result.scenarioKey,
        commandText,
        itemId,
        transcript,
        confidence: result.confidence,
        method: 'llm',
      });
      this.cleanupItem(itemId);
    } catch (error) {
      this.onInvalidTranscript?.({ itemId, transcript });
      this.maybeTriggerTimeout();
      this.cleanupItem(itemId);
    }
  }

  private resolveAliasLength(transcript: string, scenarioKey: string, preferredAlias?: string | null): number | null {
    const loweredTranscript = transcript.toLowerCase();
    const entry = this.dictionary.entries?.find((e) => e.scenarioKey === scenarioKey);
    if (!entry) return null;
    const aliases = [...(preferredAlias ? [preferredAlias] : []), ...(entry.aliases ?? [])];
    for (const alias of aliases) {
      const normalizedAlias = sanitizeAlias(alias)?.toLowerCase();
      if (!normalizedAlias) continue;
      const index = loweredTranscript.indexOf(normalizedAlias);
      if (index >= 0) {
        return index + normalizedAlias.length;
      }
    }
    return preferredAlias ? preferredAlias.length : null;
  }
}

// シンプルなレーベンシュタイン距離（小文字前提）
function levenshtein(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;
  const matrix = Array.from({ length: aLen + 1 }, () => new Array<number>(bLen + 1));
  for (let i = 0; i <= aLen; i++) matrix[i][0] = i;
  for (let j = 0; j <= bLen; j++) matrix[0][j] = j;
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[aLen][bLen];
}
