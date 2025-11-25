import { describe, expect, it, vi } from 'vitest';

import { getCurrentTimeInTimeZone, IntlTimeContextProvider } from '../TimeContextProvider';

describe('IntlTimeContextProvider', () => {
  it('returns preferred timezone when valid', () => {
    const provider = new IntlTimeContextProvider({ defaultTimeZone: 'Asia/Tokyo' });
    const result = provider.getContext('America/Los_Angeles');
    expect(result.timeZone).toBe('America/Los_Angeles');
    expect(result.usedFallback).toBe(false);
    expect(result.currentTimeIso).toMatch(/T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it('falls back to default when timezone is missing and logs warning', () => {
    const warn = vi.fn();
    const provider = new IntlTimeContextProvider({
      defaultTimeZone: 'Asia/Tokyo',
      logger: { warn } as any,
    });
    const result = provider.getContext(undefined);

    expect(result.timeZone).toBe('Asia/Tokyo');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('missing');
    expect(warn).toHaveBeenCalledWith('timezone fallback applied', {
      requestedTimeZone: null,
      fallbackTimeZone: 'Asia/Tokyo',
      reason: 'missing',
    });
  });

  it('falls back when timezone is invalid', () => {
    const warn = vi.fn();
    const provider = new IntlTimeContextProvider({
      defaultTimeZone: 'Asia/Tokyo',
      logger: { warn } as any,
    });
    const result = provider.getContext('Invalid/Zone');

    expect(result.timeZone).toBe('Asia/Tokyo');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('invalid');
    expect(warn).toHaveBeenCalled();
  });
});

describe('getCurrentTimeInTimeZone', () => {
  it('returns ISO string with offset', () => {
    const { currentTimeIso, timeZone } = getCurrentTimeInTimeZone('Asia/Tokyo');
    expect(timeZone).toBe('Asia/Tokyo');
    expect(currentTimeIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
