export type ActivityLevel = 'low' | 'moderate' | 'high';

export type GoalType = 'loss' | 'maintain' | 'gain';

export type BiologicalSex = 'male' | 'female' | 'other';

export interface UserProfile {
  userId: string;
  age?: number; // years
  sex?: BiologicalSex;
  heightCm?: number;
  weightKg?: number;
  targetWeightKg?: number;
  goalType?: GoalType; // 明示的な目標タイプ（減量/維持/増量）
  activityLevel?: ActivityLevel;
  allergies?: string[];
  dislikedFoods?: string[];
  dietStyle?: string; // e.g., ベジタリアン, 炭水化物抜き など
  mealLogs?: MealLog[];
  todayBreakfast?: string;
  todayLunch?: string;
  updatedAt: string;
}

export interface MealLog {
  id: string;
  description: string; // 自然言語で記録された食事内容
  timeOfDay?: string; // 例: 朝食/昼/夜/間食 など
  recordedAt: string; // ISO timestamp
}

export interface ProfileWithDerived extends UserProfile {
  bmi?: number;
  weightDeltaKg?: number;
  estimatedTdeeKcal?: number;
  caloricBudgetAdvice?: string;
}
