import { promises as fs } from 'node:fs';

import { FileUserProfileStore } from '../profileStore';

const TMP_PATH = '/tmp/mcpc-nutrition-profile-store.json';

describe('FileUserProfileStore', () => {
  beforeEach(async () => {
    await fs.rm(TMP_PATH, { force: true });
  });

  it('upserts and reads profiles', async () => {
    const store = new FileUserProfileStore({ filePath: TMP_PATH });
    const now = new Date().toISOString();
    const profile = {
      userId: 'u1',
      age: 30,
      heightCm: 170,
      weightKg: 65,
      updatedAt: now,
    };

    await store.upsert(profile);
    const loaded = await store.read('u1');

    expect(loaded).toEqual(profile);
  });

  it('returns null for missing profile', async () => {
    const store = new FileUserProfileStore({ filePath: TMP_PATH });
    const loaded = await store.read('missing');
    expect(loaded).toBeNull();
  });

  it('mutates profiles atomically', async () => {
    const store = new FileUserProfileStore({ filePath: TMP_PATH });
    const now = new Date().toISOString();

    const updated = await store.mutate('u2', async (existing) => {
      return {
        userId: 'u2',
        updatedAt: now,
        age: (existing?.age ?? 30) + 1,
      };
    });

    expect(updated.age).toBe(31);

    const reloaded = await store.read('u2');
    expect(reloaded?.age).toBe(31);
  });
});
