import { randomUUID } from 'node:crypto';

import { getUserProfileStore } from './profileStore';
import type { ActivityLevel, GoalType, MealLog, ProfileWithDerived, UserProfile } from './types';

const DEFAULT_USER_ID = process.env.DEMO_USER_ID ?? 'demo-user';
const DEFAULT_CLIENT_TAG = 'develop';

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

function resolveClientTag(input?: string | null): string {
  if (typeof input === 'string' && input.trim()) {
    return input.trim();
  }
  return DEFAULT_CLIENT_TAG;
}

function resolveUserIdWithTag(userId?: string | null, clientTag?: string | null): string {
  const id = resolveUserId(userId);
  if (id.includes(':')) {
    return id;
  }
  const tag = resolveClientTag(clientTag);
  return `${tag}:${id}`;
}

export async function getUserProfile(userId?: string | null, clientTag?: string | null): Promise<ProfileWithDerived> {
  const store = getUserProfileStore();
  const resolvedId = resolveUserIdWithTag(userId, clientTag);
  const existing = await store.read(resolvedId);
  const now = new Date().toISOString();
  const baseProfile: UserProfile =
    existing ??
    {
      userId: resolvedId,
      updatedAt: now,
      ...DEFAULT_PROFILE,
    };

  const profile = normalizeStoredProfile(baseProfile);

  if (profile !== baseProfile) {
    await store.upsert(profile);
  }

  if (!existing) {
    await store.upsert(profile);
  }

  return withDerived(profile);
}

export interface UpdateProfileInput {
  userId?: string | null;
  clientTag?: string | null;
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
  resetAll?: boolean | null;
}

export async function updateUserProfile(input: UpdateProfileInput): Promise<ProfileWithDerived> {
  const store = getUserProfileStore();
  const resolvedUserId = resolveUserIdWithTag(input.userId, input.clientTag);
  const current = await getUserProfile(input.userId, input.clientTag);
  const now = new Date();

  if (input.resetAll) {
    const reset: UserProfile = {
      userId: resolvedUserId,
      updatedAt: now.toISOString(),
      ...DEFAULT_PROFILE,
      mealLogs: [],
      todayMeals: undefined,
    };
    await store.upsert(reset);
    return withDerived(reset);
  }

  const normalizedMealLogAppend = normalizeMealLogAppend(input);
  const todayMealsDirect = typeof input.todayMeals === 'string' && input.todayMeals.trim()
    ? input.todayMeals.trim()
    : null;

  const next: UserProfile = {
    ...current,
    updatedAt: now.toISOString(),
    userId: resolvedUserId,
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
    mealLogs: resolveMealLogs(current.mealLogs ?? [], normalizedMealLogAppend, todayMealsDirect, now),
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

function stripTimePrefix(text: string): string {
  return text.replace(/^\s*\[[^\]]+\]\s*/u, '').trim();
}

function normalizeMealLogAppend(input: UpdateProfileInput): { description: string; timeOfDay?: string } | null {
  const fromExplicit = sanitizeMealLogAppend(input.mealLogAppend);
  if (fromExplicit) return fromExplicit;

  const fromTodayAppend = sanitizeMealLogAppend(
    typeof input.todayMealsAppend === 'string' && input.todayMealsAppend.trim()
      ? { description: input.todayMealsAppend }
      : null,
  );
  return fromTodayAppend;
}

function sanitizeMealLogAppend(
  raw?: { description?: string | null; timeOfDay?: string | null } | null,
): { description: string; timeOfDay?: string } | null {
  if (!raw) return null;
  const description = typeof raw.description === 'string' ? stripTimePrefix(raw.description) : '';
  if (!description) return null;
  const timeOfDay =
    typeof raw.timeOfDay === 'string' && raw.timeOfDay.trim() ? raw.timeOfDay.trim() : undefined;
  return { description, timeOfDay };
}

function resolveMealLogs(
  existing: MealLog[],
  append: { description: string; timeOfDay?: string } | null,
  todayMealsDirect: string | null,
  now: Date,
): MealLog[] {
  let next = existing;
  if (append && append.description?.trim()) {
    next = appendMealLog(next, append, now);
  }
  if (todayMealsDirect) {
    next = replaceTodayMealLogs(next, todayMealsDirect, now);
  }
  return next;
}

function appendMealLog(
  existing: MealLog[],
  append?: { description: string; timeOfDay?: string } | null,
  now: Date = new Date(),
): MealLog[] {
  if (!append || !append.description?.trim()) return existing;
  const nowIso = now.toISOString();
  const next: MealLog = {
    id: randomUUID(),
    description: append.description.trim(),
    timeOfDay: append.timeOfDay?.trim() || undefined,
    recordedAt: nowIso,
  };
  return [...existing.slice(-49), next]; // keep latest 50
}

function replaceTodayMealLogs(existing: MealLog[], description: string, now: Date): MealLog[] {
  const todayKey = dateKeyUtc(now);
  const filtered = existing.filter((log) => dateKeyUtc(new Date(log.recordedAt)) !== todayKey);
  const nowIso = now.toISOString();
  const replacement: MealLog = {
    id: randomUUID(),
    description: stripTimePrefix(description),
    timeOfDay: undefined,
    recordedAt: nowIso,
  };
  return [...filtered.slice(-49), replacement];
}

function dateKeyUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function normalizeStoredProfile(profile: UserProfile): UserProfile {
  if (!profile.mealLogs?.length) return profile;
  let mutated = false;
  const normalizedLogs = profile.mealLogs.map((log) => {
    const cleanDescription = typeof log.description === 'string' ? stripTimePrefix(log.description) : '';
    if (cleanDescription !== log.description) {
      mutated = true;
    }
    return {
      ...log,
      description: cleanDescription || log.description,
    };
  });

  if (!mutated) return profile;
  return { ...profile, mealLogs: normalizedLogs };
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
