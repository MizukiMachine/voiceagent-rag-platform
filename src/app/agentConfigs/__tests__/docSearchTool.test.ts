/// <reference types="vitest" />
import { describe, expect, it, vi } from 'vitest';
import { docSearchTool } from '../ragTools';

describe('docSearchTool', () => {
  it('calls ragService.searchDocuments and returns result', async () => {
    const searchDocuments = vi.fn().mockResolvedValue({
      query: 'テスト',
      items: [{ citeTag: '[FS-1]', title: 'Doc', snippet: 'Hello', source: 'gemini_file_search' }],
      summary: 'summary',
      topK: 3,
    });

    const output = await docSearchTool.invoke(
      { context: { ragService: { searchDocuments }, scenarioKey: 'b2b_rag', clientTag: 'dev' } } as any,
      JSON.stringify({ query: 'テスト', topK: 3 }),
    );

    expect(searchDocuments).toHaveBeenCalledWith({
      query: 'テスト',
      topK: 3,
      filter: undefined,
      scenarioKey: 'b2b_rag',
      clientTag: 'dev',
    });
    expect(output).toMatchObject({ success: true });
    expect((output as any).result.summary).toBe('summary');
  });

  it('returns error when service missing', async () => {
    const output = await docSearchTool.invoke({ context: {} } as any, JSON.stringify({ query: 'x' }));
    expect(output).toMatchObject({ success: false });
  });
});
