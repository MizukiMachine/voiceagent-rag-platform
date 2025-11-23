import { randomUUID } from 'node:crypto';

import { getUserProfileStore } from './profileStore';
import type { ActivityLevel, MealLog, ProfileWithDerived, UserProfile } from './types';

const DEFAULT_USER_ID = process.env.DEMO_USER_ID ?? 'demo-user';

const DEFAULT_PROFILE: Omit<UserProfile, 'userId' | 'updatedAt'> = {
  age: 32,
  sex: 'female',
  heightCm: 164,
  weightKg: 60,
  targetWeightKg: 56,
  activityLevel: 'moderate',
  allergies: ['peanut'],
};

export function resolveUserId(input?: string | null): string {
  if (typeof input === 'string' && input.trim()) {
    return input.trim();
  }
  return DEFAULT_USER_ID;
}

export async function getUserProfile(userId?: string | null): Promise<ProfileWithDerived> {
  const store = getUserProfileStore();
  const resolvedId = resolveUserId(userId);
  const existing = await store.read(resolvedId);
  const now = new Date().toISOString();
  const profile: UserProfile =
    existing ??
    {
      userId: resolvedId,
      updatedAt: now,
      ...DEFAULT_PROFILE,
    };

  if (!existing) {
    await store.upsert(profile);
  }

  return withDerived(profile);
}

export interface UpdateProfileInput {
  userId?: string | null;
  age?: number | null;
  sex?: UserProfile['sex'] | null;
  heightCm?: number | null;
  weightKg?: number | null;
  targetWeightKg?: number | null;
  activityLevel?: ActivityLevel | null;
  allergies?: string[] | null;
  dislikedFoods?: string[] | null;
  dietStyle?: string | null;
  mealLogAppend?: { description: string; timeOfDay?: string } | null;
}

export async function updateUserProfile(input: UpdateProfileInput): Promise<ProfileWithDerived> {
  const store = getUserProfileStore();
  const userId = resolveUserId(input.userId);
  const current = await getUserProfile(userId);

  const next: UserProfile = {
    ...current,
    updatedAt: new Date().toISOString(),
    age: pickNumber(input.age, current.age),
    sex: input.sex ?? current.sex,
    heightCm: pickNumber(input.heightCm, current.heightCm),
    weightKg: pickNumber(input.weightKg, current.weightKg),
    targetWeightKg: pickNumber(input.targetWeightKg, current.targetWeightKg),
    activityLevel: (input.activityLevel as ActivityLevel | undefined) ?? current.activityLevel,
    allergies: Array.isArray(input.allergies)
      ? [...input.allergies]
      : current.allergies ?? [],
    dislikedFoods: Array.isArray(input.dislikedFoods)
      ? [...input.dislikedFoods]
      : current.dislikedFoods ?? [],
    dietStyle:
      typeof input.dietStyle === 'string' && input.dietStyle.trim()
        ? input.dietStyle.trim()
        : current.dietStyle,
    mealLogs: appendMealLog(current.mealLogs ?? [], input.mealLogAppend),
  };

  await store.upsert(next);
  return withDerived(next);
}

// ------------------------------------------------------------
// Derived calculations
// ------------------------------------------------------------
function withDerived(profile: UserProfile): ProfileWithDerived {
  const bmi =
    profile.heightCm && profile.weightKg
      ? +(profile.weightKg / Math.pow(profile.heightCm / 100, 2)).toFixed(1)
      : undefined;
  const weightDeltaKg =
    typeof profile.weightKg === 'number' && typeof profile.targetWeightKg === 'number'
      ? +(profile.weightKg - profile.targetWeightKg).toFixed(1)
      : undefined;
  const estimatedTdeeKcal = estimateTdee(profile);
  const caloricBudgetAdvice = buildCaloricAdvice(profile, estimatedTdeeKcal);

  return {
    ...profile,
    bmi,
    weightDeltaKg,
    estimatedTdeeKcal,
    caloricBudgetAdvice,
  };
}

function appendMealLog(existing: MealLog[], append?: { description: string; timeOfDay?: string } | null): MealLog[] {
  if (!append || !append.description?.trim()) return existing;
  const nowIso = new Date().toISOString();
  const next: MealLog = {
    id: randomUUID(),
    description: append.description.trim(),
    timeOfDay: append.timeOfDay?.trim() || undefined,
    recordedAt: nowIso,
  };
  return [...existing.slice(-49), next]; // keep latest 50
}

function estimateTdee(profile: UserProfile): number | undefined {
  if (!profile.heightCm || !profile.weightKg || !profile.age || !profile.sex) {
    return undefined;
  }
  // Mifflin-St Jeor (approx)
  const s = profile.sex === 'male' ? 5 : profile.sex === 'female' ? -161 : -80;
  const bmr = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age + s;
  const factor =
    profile.activityLevel === 'high'
      ? 1.55
      : profile.activityLevel === 'moderate'
        ? 1.4
        : 1.2;
  return Math.round(bmr * factor);
}

function buildCaloricAdvice(profile: UserProfile, tdee?: number): string | undefined {
  if (!tdee || typeof profile.weightKg !== 'number' || typeof profile.targetWeightKg !== 'number') {
    return undefined;
  }
  const delta = profile.targetWeightKg - profile.weightKg;
  if (Math.abs(delta) < 0.1) {
    return `維持目安: 約${tdee} kcal/日`;
  }
  const direction = delta < 0 ? '減量' : '増量';
  const buffer = delta < 0 ? -400 : 300;
  return `${direction}目安: 約${tdee + buffer} kcal/日 (推定TDEE ${tdee} kcal基準)`;
}

function pickNumber(candidate: number | null | undefined, fallback: number | undefined): number | undefined {
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}
