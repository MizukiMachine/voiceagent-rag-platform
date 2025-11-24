import path from 'node:path';

import type { MemoryEntry, MemoryStore } from './memoryStore';
import { FileMemoryStore } from './memoryStore';

export const PERSISTENT_MEMORY_SOURCE = 'persistent_memory';

// 外部からも型を利用できるように再エクスポート
export type { MemoryEntry, MemoryStore } from './memoryStore';

const DEFAULT_MEMORY_FILE =
  process.env.PERSISTENT_MEMORY_FILE ?? path.join(process.cwd(), 'var', 'memory', 'persistent-memory.json');
const DEFAULT_MAX_ENTRIES =
  Number(process.env.PERSISTENT_MEMORY_LIMIT ?? '') || undefined;

let singletonStore: MemoryStore | null = null;

export function getPersistentMemoryStore(): MemoryStore {
  if (!singletonStore) {
    singletonStore = new FileMemoryStore({
      filePath: DEFAULT_MEMORY_FILE,
      maxEntriesPerKey: DEFAULT_MAX_ENTRIES,
    });
  }
  return singletonStore;
}

export function overridePersistentMemoryStore(store: MemoryStore | null) {
  singletonStore = store;
}

export function resolveMemoryKey(
  agentSetKey: string,
  provided?: string | null,
  metadata?: Record<string, any>,
): string | null {
  if (typeof provided === 'string' && provided.trim()) {
    return provided.trim();
  }
  const fromMetadata =
    typeof metadata?.memoryKey === 'string' && metadata.memoryKey.trim()
      ? metadata.memoryKey.trim()
      : null;
  if (fromMetadata) {
    return fromMetadata;
  }
  if (typeof metadata?.userId === 'string' && metadata.userId.trim()) {
    return `${agentSetKey}:${metadata.userId.trim()}`;
  }
  // デフォルトはシナリオ単位
  return agentSetKey;
}

export function buildReplayEvents(
  entries: MemoryEntry[],
  limit = 30,
): Array<Record<string, any>> {
  const slice = entries.slice(-limit);
  return slice.map((entry, idx) => ({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: entry.role,
      // Tag replayed items with a synthetic id; Realtime API rejects item.metadata,
      // so we avoid sending metadata and later skip re-persisting by this id prefix.
      id: `pm:${entry.itemId ?? idx}:${entry.createdAt}`,
      content: [
        {
          type: entry.role === 'assistant' ? 'output_text' : 'input_text',
          text: entry.text,
        },
      ],
    },
  }));
}

export function extractTextFromContent(content: any[] = []): string {
  if (!Array.isArray(content)) return '';

  const normalizeChunk = (chunk: any): string => {
    if (!chunk || typeof chunk !== 'object') return '';
    const textValue =
      typeof chunk.text === 'string'
        ? chunk.text
        : Array.isArray(chunk.text)
          ? chunk.text.join('')
          : undefined;

    switch (chunk.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        return textValue ?? '';
      case 'audio':
      case 'input_audio_transcription':
      case 'output_audio':
        return (
          (typeof chunk.transcript === 'string' && chunk.transcript) ||
          textValue ||
          ''
        );
      default:
        if (typeof chunk.transcript === 'string') {
          return chunk.transcript;
        }
        if (typeof chunk.content === 'string') {
          return chunk.content;
        }
        return textValue ?? '';
    }
  };

  return content
    .map((chunk) => normalizeChunk(chunk))
    .filter((val) => typeof val === 'string' && val.length > 0)
    .join('\n');
}

export function toMemoryEntry(
  item: any,
  now: number,
): MemoryEntry | null {
  if (!item || item.type !== 'message') return null;
  const itemId = item.itemId ?? item.item_id ?? item.id;
  if (typeof itemId === 'string' && itemId.startsWith('pm:')) return null;
  if (item?.metadata?.source === PERSISTENT_MEMORY_SOURCE) return null;
  const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
  if (!role) return null;
  const text = extractTextFromContent(item.content ?? []);
  if (!text) return null;
  const createdAt =
    typeof item.created_at === 'string'
      ? item.created_at
      : new Date(now).toISOString();

  return {
    itemId: item.itemId ?? item.item_id ?? item.id,
    role,
    text,
    createdAt,
  };
}
