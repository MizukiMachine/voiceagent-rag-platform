import { afterEach, describe, expect, it, vi } from 'vitest';
import { File } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ImageUploadError,
  persistImage,
  resolveAllowedMimeTypes,
  resolveMaxBytes,
} from '../imageUploadService';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

vi.mock('@google-cloud/storage', () => {
  const buckets: any[] = [];

  class MockFile {
    public saved: any[] = [];
    constructor(public name: string) {}
    async save(content: Buffer, options: any) {
      this.saved.push({ content, options });
    }
  }

  class MockBucket {
    public files: MockFile[] = [];
    constructor(public name: string) {}
    file(name: string) {
      const f = new MockFile(name);
      this.files.push(f);
      return f;
    }
  }

  class Storage {
    bucket(name: string) {
      const b = new MockBucket(name);
      buckets.push(b);
      return b;
    }
  }

  return { Storage, __buckets: buckets };
});

describe('imageUploadService', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tmpDirs.map(async (dir) => {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }),
    );
    tmpDirs.length = 0;
  });

  it('persists an allowed image and returns metadata with base64', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'img-store-'));
    tmpDirs.push(tmp);
    const file = new File([PNG_BYTES], 'sample.png', { type: 'image/png' });

    const stored = await persistImage({
      file,
      sessionId: 'sess_test',
      baseDir: tmp,
      maxBytes: 1024,
    });

    expect(stored.mimeType).toBe('image/png');
    expect(stored.size).toBe(PNG_BYTES.length);
    expect(stored.base64).toBe(PNG_BYTES.toString('base64'));
    expect(stored.storagePath).toBeDefined();
    const exists = await fs.stat(stored.storagePath!);
    expect(exists.isFile()).toBe(true);
  });

  it('rejects unsupported mime types', async () => {
    const file = new File([PNG_BYTES], 'text.txt', { type: 'text/plain' });
    await expect(
      persistImage({ file, sessionId: 'sess_test', baseDir: os.tmpdir(), maxBytes: 1024 }),
    ).rejects.toThrow(ImageUploadError);
  });

  it('rejects files that exceed the configured max bytes', async () => {
    const smallLimit = 4;
    const file = new File([PNG_BYTES], 'oversize.png', { type: 'image/png' });
    await expect(
      persistImage({
        file,
        sessionId: 'sess_test',
        baseDir: os.tmpdir(),
        maxBytes: smallLimit,
      }),
    ).rejects.toThrow(ImageUploadError);
  });

  it('uploads to GCS when configured', async () => {
    const { __buckets } = await import('@google-cloud/storage');
    process.env.IMAGE_UPLOAD_TARGET = 'gcs';
    process.env.IMAGE_UPLOAD_GCS_BUCKET = 'test-bucket';
    process.env.IMAGE_UPLOAD_GCS_PREFIX = 'tmp/';

    const file = new File([PNG_BYTES], 'sample.png', { type: 'image/png' });
    const stored = await persistImage({
      file,
      sessionId: 'sess_test',
      maxBytes: 1024,
    });

    expect(stored.storagePath).toMatch(/^gs:\/\/test-bucket\/tmp\/sess_test-[a-f0-9-]+\.png$/);
    expect(stored.mimeType).toBe('image/png');
    expect(stored.size).toBe(PNG_BYTES.length);
    expect(__buckets[0]?.files[0]?.saved?.[0]?.options?.contentType).toBe('image/png');

    delete process.env.IMAGE_UPLOAD_TARGET;
    delete process.env.IMAGE_UPLOAD_GCS_BUCKET;
    delete process.env.IMAGE_UPLOAD_GCS_PREFIX;
  });

  it('skips persistence when memory target is selected', async () => {
    process.env.IMAGE_UPLOAD_TARGET = 'memory';

    const file = new File([PNG_BYTES], 'sample.png', { type: 'image/png' });
    const stored = await persistImage({
      file,
      sessionId: 'sess_test',
      maxBytes: 1024,
    });

    expect(stored.storagePath).toBeUndefined();
    expect(stored.base64).toBe(PNG_BYTES.toString('base64'));

    delete process.env.IMAGE_UPLOAD_TARGET;
  });

  it('throws when GCS target is selected without bucket', async () => {
    process.env.IMAGE_UPLOAD_TARGET = 'gcs';
    const file = new File([PNG_BYTES], 'sample.png', { type: 'image/png' });
    await expect(
      persistImage({ file, sessionId: 'sess_test', maxBytes: 1024 }),
    ).rejects.toThrow();
    delete process.env.IMAGE_UPLOAD_TARGET;
  });

  it('parses environment overrides for allowed mimetypes and max bytes', () => {
    process.env.IMAGE_UPLOAD_ALLOWED_MIME_TYPES = 'image/png';
    process.env.IMAGE_UPLOAD_MAX_BYTES = '1234';
    expect(resolveAllowedMimeTypes()).toEqual(['image/png']);
    expect(resolveMaxBytes()).toBe(1234);
    delete process.env.IMAGE_UPLOAD_ALLOWED_MIME_TYPES;
    delete process.env.IMAGE_UPLOAD_MAX_BYTES;
  });
});
