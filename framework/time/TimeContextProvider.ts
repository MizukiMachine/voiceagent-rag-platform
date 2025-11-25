import { createServiceToken, ServiceManagerLogger } from '../di/ServiceManager';

export interface TimeContext {
  currentTimeIso: string;
  timeZone: string;
  usedFallback: boolean;
  requestedTimeZone?: string | null;
  fallbackReason?: 'missing' | 'invalid';
}

export interface TimeContextProvider {
  getContext(preferredTimeZone?: string | null): TimeContext;
}

export const timeContextProviderToken = createServiceToken<TimeContextProvider>('TimeContextProvider');

const DEFAULT_TIME_ZONE = process.env.DEFAULT_TIME_ZONE ?? 'Asia/Tokyo';

type IntlProviderOptions = {
  defaultTimeZone?: string;
  logger?: ServiceManagerLogger;
};

/**
 * TimeContextProvider 実装。
 * - preferredTimeZone が妥当ならそれを使用
 * - 未指定または不正な場合は defaultTimeZone へフォールバックし、warn を記録
 */
export class IntlTimeContextProvider implements TimeContextProvider {
  private readonly defaultTimeZone: string;
  private readonly logger?: ServiceManagerLogger;

  constructor(options: IntlProviderOptions = {}) {
    this.defaultTimeZone = options.defaultTimeZone ?? DEFAULT_TIME_ZONE;
    this.logger = options.logger;
  }

  getContext(preferredTimeZone?: string | null): TimeContext {
    const validation = this.resolveTimeZone(preferredTimeZone);
    const { currentTimeIso } = getCurrentTimeInTimeZone(validation.timeZone);

    if (validation.usedFallback) {
      this.logger?.warn?.('timezone fallback applied', {
        requestedTimeZone: preferredTimeZone ?? null,
        fallbackTimeZone: validation.timeZone,
        reason: validation.fallbackReason ?? 'missing',
      });
    }

    return {
      currentTimeIso,
      timeZone: validation.timeZone,
      usedFallback: validation.usedFallback,
      requestedTimeZone: preferredTimeZone ?? null,
      fallbackReason: validation.fallbackReason,
    };
  }

  private resolveTimeZone(timeZone?: string | null): {
    timeZone: string;
    usedFallback: boolean;
    fallbackReason?: 'missing' | 'invalid';
  } {
    if (this.isValidTimeZone(timeZone)) {
      return { timeZone: timeZone!, usedFallback: false };
    }

    return {
      timeZone: this.defaultTimeZone,
      usedFallback: true,
      fallbackReason: timeZone ? 'invalid' : 'missing',
    };
  }

  private isValidTimeZone(timeZone?: string | null): boolean {
    if (!timeZone) return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Intl.DateTimeFormat を用いて「YYYY-MM-DDTHH:mm:ss±HH:MM」形式を生成。
 * 秒精度で十分なためミリ秒は落とす。
 */
export function getCurrentTimeInTimeZone(timeZone: string): { currentTimeIso: string; timeZone: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);

  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const time = `${pick('hour')}:${pick('minute')}:${pick('second')}`;

  const tzName = pick('timeZoneName'); // e.g., "GMT+9" or "GMT+09:00"
  let offset = '+00:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (match) {
    const sign = match[1];
    const hours = match[2].padStart(2, '0');
    const minutes = (match[3] ?? '00').padStart(2, '0');
    offset = `${sign}${hours}:${minutes}`;
  }

  return { currentTimeIso: `${date}T${time}${offset}`, timeZone };
}
