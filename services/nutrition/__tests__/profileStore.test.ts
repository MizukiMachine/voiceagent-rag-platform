import { FileUserProfileStore } from '../profileStore';

const TMP_PATH = '/tmp/mcpc-nutrition-profile-store.json';

describe('FileUserProfileStore', () => {
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
});
