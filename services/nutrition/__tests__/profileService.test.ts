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
    __reset() {
      Object.keys(memory).forEach((key) => delete memory[key]);
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
    vi.setSystemTime(new Date('2025-11-25T00:00:00Z'));
    (getUserProfileStore() as any).__reset?.();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default profile with derived fields when missing', async () => {
    const profile = await getUserProfile(userId);

    expect(profile.userId).toBe(`develop:${userId}`);
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

  it('appends mealLogs when todayMealsAppend is provided (image ingestion path)', async () => {
    await getUserProfile(userId);

    const updated = await updateUserProfile({
      userId,
      todayMealsAppend: 'バナナ',
    });

    expect(updated.todayMeals).toBe('バナナ');
    expect(updated.mealLogs?.at(-1)?.description).toBe('バナナ');
  });

  it('falls back to todayMealsAppend when mealLogAppend description is blank', async () => {
    await getUserProfile(userId);

    const updated = await updateUserProfile({
      userId,
      mealLogAppend: { description: '   ', timeOfDay: '昼' },
      todayMealsAppend: 'バナナヨーグルト',
    });

    expect(updated.mealLogs?.at(-1)?.description).toBe('バナナヨーグルト');
    expect(updated.mealLogs?.at(-1)?.timeOfDay).toBeUndefined();
    expect(updated.todayMeals).toContain('バナナヨーグルト');
  });

  it('replaces today mealLogs when todayMeals is set directly (dashboard edit)', async () => {
    await getUserProfile(userId);
    await updateUserProfile({
      userId,
      mealLogAppend: { description: 'ラーメン', timeOfDay: '昼' },
    });

    vi.setSystemTime(new Date('2025-11-25T12:00:00Z'));

    const updated = await updateUserProfile({
      userId,
      todayMeals: 'ヨーグルト',
    });

    expect(updated.mealLogs?.length).toBe(1);
    expect(updated.mealLogs?.at(-1)?.description).toBe('ヨーグルト');
    expect(updated.mealLogs?.at(-1)?.timeOfDay).toBeUndefined();
    expect(updated.todayMeals).toBe('ヨーグルト');
  });

  it('resets all fields and logs when resetAll is true', async () => {
    await updateUserProfile({
      userId,
      age: 40,
      dietStyle: '低脂質',
      mealLogAppend: { description: 'カレー', timeOfDay: '夜' },
      todayMeals: 'カレーとサラダ',
    });

    const updated = await updateUserProfile({ userId, resetAll: true });

    expect(updated.mealLogs?.length ?? 0).toBe(0);
    expect(updated.todayMeals).toBeUndefined();
    expect(updated.age).toBe(32); // default
    expect(updated.dietStyle).toBeUndefined();
  });

  it('keeps profiles isolated per clientTag', async () => {
    const tagA = 'develop';
    const tagB = 'glasses01';

    await updateUserProfile({
      userId,
      clientTag: tagA,
      mealLogAppend: { description: 'Aの食事' },
    });
    await updateUserProfile({
      userId,
      clientTag: tagB,
      mealLogAppend: { description: 'Bの食事' },
    });

    const profileA = await getUserProfile(userId, tagA);
    const profileB = await getUserProfile(userId, tagB);

    expect(profileA.mealLogs?.at(-1)?.description).toBe('Aの食事');
    expect(profileB.mealLogs?.at(-1)?.description).toBe('Bの食事');
    expect(profileA.userId).not.toBe(profileB.userId);
  });
});
