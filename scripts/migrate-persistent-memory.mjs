#!/usr/bin/env node
// Merge legacy agentSet:clientTag keys into clientTag keys and drop stale entries.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const storePath = process.env.PERSISTENT_MEMORY_FILE ?? path.join(process.cwd(), 'var', 'memory', 'persistent-memory.json');

async function main() {
  let payload;
  try {
    const raw = await readFile(storePath, 'utf-8');
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to read memory store', err);
    process.exit(1);
  }
  if (!payload?.memories) {
    console.error('No memories found in store');
    process.exit(1);
  }

  const memories = payload.memories;
  let changed = false;

  for (const key of Object.keys(memories)) {
    const legacyMatch = key.match(/^(.+?):(.+)$/);
    if (!legacyMatch) continue;
    const clientTag = legacyMatch[2];
    const targetKey = clientTag;
    const list = memories[key] ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      delete memories[key];
      changed = true;
      continue;
    }
    const targetList = memories[targetKey] ?? [];
    const byId = new Map();
    [...targetList, ...list].forEach((entry) => {
      const uid = entry.itemId ?? `${entry.createdAt}:${entry.role}`;
      const existing = byId.get(uid);
      if (!existing || new Date(entry.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
        byId.set(uid, entry);
      }
    });
    memories[targetKey] = Array.from(byId.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    delete memories[key];
    changed = true;
    console.log(`Merged legacy key ${key} -> ${targetKey} (${list.length} entries)`);
  }

  if (!changed) {
    console.log('No legacy keys found; nothing to do.');
    return;
  }

  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(payload, null, 2), 'utf-8');
  console.log('Persistent memory migrated and saved to', storePath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
