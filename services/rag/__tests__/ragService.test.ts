/// <reference types="vitest" />
import { describe, expect, it } from 'vitest';
import { RagService } from '../ragService';
import type { RagRetriever } from '../types';

class StubRetriever implements RagRetriever {
  constructor(private readonly items: any[]) {}

  async search() {
    return { items: this.items, tookMs: 12 };
  }
}

describe('RagService', () => {
  it('adds cite tags and renders summary', async () => {
    const retriever = new StubRetriever([
      { id: 'doc-1', title: 'Doc1', snippet: 'First snippet' },
      { id: 'doc-2', snippet: 'Second snippet' },
    ]);
    const service = new RagService({ retriever });

    const result = await service.searchDocuments({ query: 'hello', topK: 2 });
    expect(result.items[0].citeTag).toBe('[FS-1]');
    expect(result.items[1].citeTag).toBe('[FS-2]');
    expect(result.summary).toMatch(/\[FS-1\]/);
    expect(result.summary).toMatch(/Doc1/);
  });

  it('handles empty results gracefully', async () => {
    const service = new RagService({ retriever: new StubRetriever([]) });
    const result = await service.searchDocuments({ query: 'none' });
    expect(result.items).toHaveLength(0);
    expect(result.summary).toContain('No supporting documents');
  });
});
