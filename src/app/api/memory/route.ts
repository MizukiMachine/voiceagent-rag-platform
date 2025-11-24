import { NextResponse } from 'next/server';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
      await cleanupLegacyKeysByClientTag(payload.clientTag);
    }

    return NextResponse.json({ ok: true, memoryKey: resolvedKey });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function cleanupLegacyKeysByClientTag(clientTag: string): Promise<void> {
  const filePath =
    process.env.PERSISTENT_MEMORY_FILE ??
    path.join(process.cwd(), 'var', 'memory', 'persistent-memory.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed?.memories || typeof parsed.memories !== 'object') return;
    let changed = false;
    for (const key of Object.keys(parsed.memories)) {
      if (key.endsWith(`:${clientTag}`)) {
        delete parsed.memories[key];
        changed = true;
      }
    }
    if (changed) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
    }
  } catch {
    // best-effort cleanup; ignore errors
  }
}
