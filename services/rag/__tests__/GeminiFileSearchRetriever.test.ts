/// <reference types="vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiFileSearchRetriever } from '../GeminiFileSearchRetriever';
import type { GeminiFileSearchConfig } from '../config';

const baseConfig: GeminiFileSearchConfig = {
  projectId: 'demo-project',
  location: 'global',
  storeId: 'demo-store',
  servingConfigId: 'default_serving_config',
  storeKind: 'fileStores',
  apiEndpoint: 'example.com',
  apiVersion: 'v1beta',
  defaultTopK: 5,
};

describe('GeminiFileSearchRetriever', () => {
  const fakeToken = 'ya29.fake';
  let retriever: GeminiFileSearchRetriever;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();

    retriever = new GeminiFileSearchRetriever(baseConfig, { fetchImpl: fetchSpy as any });

    vi.spyOn(retriever as any, 'getAccessToken').mockResolvedValue(fakeToken);
  });

  it('sends search request to servingConfig search endpoint', async () => {
    fetchSpy.mockResolvedValue(
      createResponse({
        results: [
          {
            id: 'abc',
            document: { id: 'doc1', derivedStructData: { title: 'Demo', snippets: ['hello'] } },
          },
        ],
      }),
    );

    await retriever.search({ query: 'kubernetes', topK: 3, filter: 'mimeType:pdf' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      `https://${baseConfig.apiEndpoint}/${baseConfig.apiVersion}/projects/${baseConfig.projectId}/locations/${baseConfig.location}/${baseConfig.storeKind}/${baseConfig.storeId}/servingConfigs/${baseConfig.servingConfigId}:search`,
    );
    const body = JSON.parse((options as any).body);
    expect(body.query).toBe('kubernetes');
    expect(body.pageSize).toBe(3);
    expect(body.filter).toBe('mimeType:pdf');
    expect((options as any).headers.Authorization).toBe(`Bearer ${fakeToken}`);
  });

  it('maps response results into retriever documents', async () => {
    fetchSpy.mockResolvedValue(
      createResponse({
        results: [
          {
            id: 'hit-1',
            score: 0.9,
            document: {
              id: 'doc-123',
              derivedStructData: {
                title: 'Guide',
                snippets: ['First snippet'],
                uri: 'https://example.com/guide',
              },
            },
          },
        ],
      }),
    );

    const result = await retriever.search({ query: 'snippets' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'doc-123',
      title: 'Guide',
      uri: 'https://example.com/guide',
      snippet: 'First snippet',
      score: 0.9,
    });
    expect(typeof result.tookMs).toBe('number');
  });

  it('throws with status text on non-2xx', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'permission denied',
      json: async () => ({}),
    });

    await expect(retriever.search({ query: 'denied' })).rejects.toThrow(/403/i);
  });
});

function createResponse(body: any) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
