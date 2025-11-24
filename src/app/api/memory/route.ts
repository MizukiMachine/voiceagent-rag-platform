import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  getPersistentMemoryStore,
  resolveMemoryKey,
} from '../../../../services/coreData/persistentMemory';
import { handleRouteError, requireBffSecret } from '../session/utils';

const resetSchema = z.object({
  agentSetKey: z.string().min(1),
  memoryKey: z.string().min(1).optional(),
  clientTag: z.string().min(1).optional(),
});

export async function DELETE(request: Request) {
  try {
    requireBffSecret(request);
    const json = await request.json().catch(() => ({}));
    const payload = resetSchema.parse(json);
    const resolvedKey = resolveMemoryKey(
      payload.agentSetKey,
      payload.memoryKey,
      undefined,
      payload.clientTag,
    );
    if (!resolvedKey) {
      return NextResponse.json(
        { error: 'memory_disabled', message: 'Persistent memory is not enabled.' },
        { status: 400 },
      );
    }

    const store = getPersistentMemoryStore();
    await store.reset(resolvedKey);

    if (payload.clientTag) {
      const legacyKey = `${payload.agentSetKey}:${payload.clientTag}`;
      if (legacyKey !== resolvedKey) {
        await store.reset(legacyKey);
      }
    }

    return NextResponse.json({ ok: true, memoryKey: resolvedKey });
  } catch (error) {
    return handleRouteError(error);
  }
}
