import { randomUUID } from 'node:crypto';

import { getUserProfileStore } from './profileStore';
import type { ActivityLevel, GoalType, MealLog, ProfileWithDerived, UserProfile } from './types';

const DEFAULT_USER_ID = process.env.DEMO_USER_ID ?? 'demo-user';

const DEFAULT_PROFILE: Omit<UserProfile, 'userId' | 'updatedAt'> = {
  age: 32,
  sex: 'female',
  heightCm: 164,
  weightKg: 60,
  goalType: 'loss',
  activityLevel: 'moderate',
  avoidFoods: undefined,
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
  goalType?: GoalType | null;
  activityLevel?: ActivityLevel | null;
  avoidFoods?: string | null;
  dietStyle?: string | null;
  mealLogAppend?: { description: string; timeOfDay?: string } | null;
  todayMeals?: string | null;
  todayMealsAppend?: string | null;
}

export async function updateUserProfile(input: UpdateProfileInput): Promise<ProfileWithDerived> {
  const store = getUserProfileStore();
  const userId = resolveUserId(input.userId);
  const current = await getUserProfile(userId);

  const normalizedMealLogAppend =
    input.mealLogAppend ??
    (typeof input.todayMealsAppend === 'string' && input.todayMealsAppend.trim()
      ? { description: input.todayMealsAppend.trim(), timeOfDay: undefined }
      : null);

  const next: UserProfile = {
    ...current,
    updatedAt: new Date().toISOString(),
    age: pickNumber(input.age, current.age),
    sex: input.sex ?? current.sex,
    heightCm: pickNumber(input.heightCm, current.heightCm),
    weightKg: pickNumber(input.weightKg, current.weightKg),
    goalType: (input.goalType as GoalType | undefined) ?? current.goalType,
    activityLevel: (input.activityLevel as ActivityLevel | undefined) ?? current.activityLevel,
    avoidFoods:
      typeof input.avoidFoods === 'string' && input.avoidFoods.trim()
        ? input.avoidFoods.trim()
        : current.avoidFoods,
    dietStyle:
      typeof input.dietStyle === 'string' && input.dietStyle.trim()
        ? input.dietStyle.trim()
        : current.dietStyle,
    mealLogs: appendMealLog(current.mealLogs ?? [], normalizedMealLogAppend),
    todayMeals: resolveTodayMeals(current.todayMeals, input.todayMeals, input.todayMealsAppend),
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
  const estimatedTdeeKcal = estimateTdee(profile);
  const caloricBudgetAdvice = buildCaloricAdvice(profile, estimatedTdeeKcal);

  return {
    ...profile,
    bmi,
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

function resolveTodayMeals(
  current: string | undefined,
  direct?: string | null,
  append?: string | null,
): string | undefined {
  const directTrimmed = typeof direct === 'string' && direct.trim() ? direct.trim() : undefined;
  if (directTrimmed !== undefined) return directTrimmed;

  const appendTrimmed = typeof append === 'string' && append.trim() ? append.trim() : undefined;
  if (appendTrimmed) {
    return current && current.trim() ? `${current.trim()} / ${appendTrimmed}` : appendTrimmed;
  }

  return current;
}

function buildCaloricAdvice(profile: UserProfile, tdee?: number): string | undefined {
  if (!tdee) {
    return undefined;
  }
  const goal = resolveGoalType(profile);
  if (!goal) return undefined;

  if (goal === 'maintain') {
    return `維持目安: 約${tdee} kcal/日 (推定TDEE ${tdee} kcal基準)`;
  }

  const isLoss = goal === 'loss';
  const buffer = isLoss ? -400 : 300;
  const direction = isLoss ? '減量' : '増量';
  return `${direction}目安: 約${tdee + buffer} kcal/日 (推定TDEE ${tdee} kcal基準)`;
}

function pickNumber(candidate: number | null | undefined, fallback: number | undefined): number | undefined {
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}

function resolveGoalType(profile: UserProfile): GoalType | undefined {
  if (profile.goalType) return profile.goalType;
  return undefined;
}
