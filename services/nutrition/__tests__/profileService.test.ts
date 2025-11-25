import { afterEach, beforeEach, vi } from 'vitest';

import { getUserProfileStore } from '../profileStore';
import { getUserProfile, updateUserProfile } from '../profileService';

// Reset singleton store between tests by clearing require cache
vi.mock('../profileStore', async () => {
  const actual = await vi.importActual<typeof import('../profileStore')>('../profileStore');
  // Use in-memory stub for isolation
  const memory: Record<string, any> = {};
  const mockStore = {
    async read(userId: string) {
      return memory[userId] ?? null;
    },
    async upsert(profile: any) {
      memory[profile.userId] = { ...profile };
    },
  };

  return {
    ...actual,
    getUserProfileStore: () => mockStore,
  };
});

describe('profileService', () => {
  const userId = 'demo-user';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-11-23T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default profile with derived fields when missing', async () => {
    const profile = await getUserProfile(userId);

    expect(profile.userId).toBe(userId);
    expect(profile.bmi).toBeDefined();
    expect(profile.estimatedTdeeKcal).toBeGreaterThan(0);
  });

  it('updates profile and recalculates derived values', async () => {
    await getUserProfile(userId);
    const updated = await updateUserProfile({
      userId,
      weightKg: 70,
      activityLevel: 'high',
    });

    expect(updated.weightKg).toBe(70);
    expect(updated.caloricBudgetAdvice).toContain('減量目安');
  });

  it('prefers explicit goalType=maintain over weight delta when building advice', async () => {
    await getUserProfile(userId);
    const updated = await updateUserProfile({
      userId,
      goalType: 'maintain',
    });

    expect(updated.caloricBudgetAdvice).toContain('維持目安');
    expect(updated.caloricBudgetAdvice).toContain(String(updated.estimatedTdeeKcal));
  });

  it('supports gain mode and applies positive caloric buffer', async () => {
    await getUserProfile(userId);
    const updated = await updateUserProfile({
      userId,
      weightKg: 58,
      goalType: 'gain',
    });

    const expected = (updated.estimatedTdeeKcal ?? 0) + 300;
    expect(updated.caloricBudgetAdvice).toContain('増量目安');
    expect(updated.caloricBudgetAdvice).toContain(String(expected));
  });
});
