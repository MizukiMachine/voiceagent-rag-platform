import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UserProfile } from './types';

export interface UserProfileStore {
  read(userId: string): Promise<UserProfile | null>;
  upsert(profile: UserProfile): Promise<void>;
}

interface FileUserProfileStoreOptions {
  filePath: string;
}

interface PersistedPayload {
  version: number;
  profiles: Record<string, UserProfile>;
}

const DEFAULT_PROFILE_FILE =
  process.env.NUTRITION_PROFILE_FILE ??
  path.join(process.cwd(), 'var', 'nutrition', 'profiles.json');

let singleton: UserProfileStore | null = null;

export function getUserProfileStore(): UserProfileStore {
  if (!singleton) {
    singleton = new FileUserProfileStore({ filePath: DEFAULT_PROFILE_FILE });
  }
  return singleton;
}

export class FileUserProfileStore implements UserProfileStore {
  private readonly filePath: string;

  constructor(options: FileUserProfileStoreOptions) {
    this.filePath = options.filePath;
  }

  async read(userId: string): Promise<UserProfile | null> {
    const payload = await this.load();
    const profile = payload.profiles[userId];
    return profile ? { ...profile } : null;
  }

  async upsert(profile: UserProfile): Promise<void> {
    await this.exclusive(async () => {
      const payload = await this.load();
      payload.profiles[profile.userId] = { ...profile };
      await this.save(payload);
    });
  }

  // ------------------------------------------------------------
  // internal helpers
  // ------------------------------------------------------------
  private mutex: Promise<void> = Promise.resolve();

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<PersistedPayload> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedPayload;
      if (parsed.version === 1 && parsed.profiles) {
        return parsed;
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        console.warn('[nutrition-profile] failed to read store', { error });
      }
    }
    return { version: 1, profiles: {} };
  }

  private async save(payload: PersistedPayload): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(payload), 'utf-8');
  }
}
