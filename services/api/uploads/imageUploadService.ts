import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

export type SupportedMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export interface StoredImage {
  id: string;
  size: number;
  mimeType: SupportedMimeType;
  originalName?: string;
  storagePath?: string;
  base64: string;
}

export class ImageUploadError extends Error {
  public readonly code: 'missing_file' | 'invalid_type' | 'too_large';
  public readonly status: number;

  constructor(message: string, code: ImageUploadError['code'], status = 400) {
    super(message);
    this.name = 'ImageUploadError';
    this.code = code;
    this.status = status;
  }
}

interface PersistOptions {
  file: Blob;
  sessionId: string;
  maxBytes?: number;
  allowedMimeTypes?: SupportedMimeType[];
  baseDir?: string;
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const DEFAULT_ALLOWED: SupportedMimeType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

export function resolveAllowedMimeTypes(): SupportedMimeType[] {
  const raw = process.env.IMAGE_UPLOAD_ALLOWED_MIME_TYPES;
  if (!raw) return DEFAULT_ALLOWED;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is SupportedMimeType =>
      ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(t),
    );
}

export function resolveMaxBytes(): number {
  const raw = process.env.IMAGE_UPLOAD_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

export function resolveBaseDir(): string {
  const configured =
    process.env.IMAGE_UPLOAD_DIR ||
    path.join(process.cwd(), 'var', 'uploads', 'images');
  return configured;
}

type FileLike = Blob & { name?: string; type?: string };

function isFileLike(file: unknown): file is FileLike {
  return (
    !!file &&
    typeof file === 'object' &&
    typeof (file as Blob).arrayBuffer === 'function' &&
    typeof (file as any).type === 'string'
  );
}

function ensureFile(file: Blob | null | undefined): asserts file is FileLike {
  if (!isFileLike(file)) {
    throw new ImageUploadError('画像ファイルが指定されていません', 'missing_file', 400);
  }
}

function assertMimeType(file: FileLike, allowed: SupportedMimeType[]) {
  const mime = file.type as SupportedMimeType;
  if (!allowed.includes(mime)) {
    throw new ImageUploadError(`未対応のMIMEタイプです: ${mime || 'unknown'}`, 'invalid_type', 400);
  }
}

function assertSize(buffer: Buffer, maxBytes: number) {
  if (buffer.byteLength > maxBytes) {
    throw new ImageUploadError(
      `ファイルサイズが上限(${maxBytes} bytes)を超えています`,
      'too_large',
      413,
    );
  }
}

function inferExtension(mime: SupportedMimeType): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

interface SaveOptions {
  fileName: string;
  buffer: Buffer;
  contentType: SupportedMimeType;
  baseDir?: string;
}

interface ImageStorage {
  save(options: SaveOptions): Promise<string | undefined /* storagePath */>;
}

class LocalImageStorage implements ImageStorage {
  async save({ fileName, buffer, baseDir }: SaveOptions): Promise<string> {
    const dir = baseDir ?? resolveBaseDir();
    const storagePath = path.join(dir, fileName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(storagePath, buffer);
    return storagePath;
  }
}

class InMemoryImageStorage implements ImageStorage {
  async save(): Promise<undefined> {
    // 何も保存せずに実メディアを保持しない。base64は呼び出し元が返す。
    return undefined;
  }
}

class GcsImageStorage implements ImageStorage {
  private bucketName: string;
  private prefix: string;
  private storage: Storage;

  constructor(bucketName: string, prefix?: string) {
    this.bucketName = bucketName;
    this.prefix = normalizePrefix(prefix);
    this.storage = new Storage();
  }

  async save({ fileName, buffer, contentType }: SaveOptions): Promise<string> {
    const objectPath = path.posix.join(this.prefix, fileName);
    const bucket = this.storage.bucket(this.bucketName);
    await bucket.file(objectPath).save(buffer, {
      resumable: false,
      contentType,
      metadata: {
        // Content-Typeを維持し、将来Signed URLなどを使う場合に備える
        contentType,
      },
    });
    return `gs://${bucket.name}/${objectPath}`;
  }
}

function normalizePrefix(prefix?: string): string {
  if (!prefix) return '';
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

function resolveStorage(): ImageStorage {
  const target = (process.env.IMAGE_UPLOAD_TARGET ?? 'local').toLowerCase();
  if (target === 'gcs') {
    const bucket = process.env.IMAGE_UPLOAD_GCS_BUCKET;
    if (!bucket) {
      throw new ImageUploadError('GCS保存先バケット(IMAGE_UPLOAD_GCS_BUCKET)が未設定です', 'missing_file', 500);
    }
    const prefix = process.env.IMAGE_UPLOAD_GCS_PREFIX;
    return new GcsImageStorage(bucket, prefix);
  }
  if (target === 'memory') {
    return new InMemoryImageStorage();
  }
  return new LocalImageStorage();
}

export async function persistImage(options: PersistOptions): Promise<StoredImage> {
  ensureFile(options.file);
  const maxBytes = options.maxBytes ?? resolveMaxBytes();
  const allowed = options.allowedMimeTypes ?? resolveAllowedMimeTypes();
  assertMimeType(options.file, allowed);

  const buffer = Buffer.from(await options.file.arrayBuffer());
  assertSize(buffer, maxBytes);

  const mimeType = options.file.type as SupportedMimeType;
  const extension = inferExtension(mimeType);
  const id = randomUUID();
  const fileName = `${options.sessionId}-${id}.${extension}`;
  const storage = resolveStorage();
  const storagePath = await storage.save({
    fileName,
    buffer,
    contentType: mimeType,
    baseDir: options.baseDir,
  });

  return {
    id,
    size: buffer.byteLength,
    mimeType,
    originalName: options.file.name || undefined,
    storagePath,
    base64: buffer.toString('base64'),
  };
}
