import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getUserProfile, updateUserProfile } from '../../../../../services/nutrition/profileService';

const patchSchema = z.object({
  userId: z.string().trim().optional(),
  age: z.number().int().min(1).max(120).optional(),
  sex: z.enum(['male', 'female', 'other']).optional(),
  heightCm: z.number().min(80).max(250).optional(),
  weightKg: z.number().min(20).max(300).optional(),
  goalType: z.enum(['loss', 'maintain', 'gain']).optional(),
  activityLevel: z.enum(['low', 'moderate', 'high']).optional(),
  avoidFoods: z.string().trim().min(1).max(400).optional(),
  dietStyle: z.string().trim().min(1).max(120).optional(),
  mealLogAppend: z
    .object({
      description: z.string().trim().min(1),
      timeOfDay: z.string().trim().min(1).max(32).optional(),
    })
    .optional(),
  todayMeals: z.string().trim().min(1).max(400).optional(),
  todayMealsAppend: z.string().trim().min(1).max(400).optional(),
  resetAll: z.boolean().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id') ?? undefined;
  const profile = await getUserProfile(userId);
  return NextResponse.json({ profile });
}

export async function PATCH(request: Request) {
  try {
    const json = await request.json();
    const payload = patchSchema.parse(json);
    const profile = await updateUserProfile(payload);
    return NextResponse.json({ profile });
  } catch (error: any) {
    if (error?.issues) {
      return NextResponse.json({ error: 'invalid_payload', issues: error.issues }, { status: 400 });
    }
    return NextResponse.json(
      { error: 'internal_error', message: 'Failed to update profile' },
      { status: 500 },
    );
  }
}
