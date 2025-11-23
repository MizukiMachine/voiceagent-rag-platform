export type ActivityLevel = 'low' | 'moderate' | 'high';

export type BiologicalSex = 'male' | 'female' | 'other';

export interface UserProfile {
  userId: string;
  age?: number; // years
  sex?: BiologicalSex;
  heightCm?: number;
  weightKg?: number;
  targetWeightKg?: number;
  activityLevel?: ActivityLevel;
  allergies?: string[];
  updatedAt: string;
}

export interface ProfileWithDerived extends UserProfile {
  bmi?: number;
  weightDeltaKg?: number;
  estimatedTdeeKcal?: number;
  caloricBudgetAdvice?: string;
}
