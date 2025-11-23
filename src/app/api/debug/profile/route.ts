import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getUserProfile, updateUserProfile } from '../../../../../services/nutrition/profileService';

const patchSchema = z.object({
  userId: z.string().trim().optional(),
  age: z.number().int().min(1).max(120).optional(),
  sex: z.enum(['male', 'female', 'other']).optional(),
  heightCm: z.number().min(80).max(250).optional(),
  weightKg: z.number().min(20).max(300).optional(),
  targetWeightKg: z.number().min(20).max(300).optional(),
  activityLevel: z.enum(['low', 'moderate', 'high']).optional(),
  allergies: z.array(z.string().trim().min(1)).optional(),
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
