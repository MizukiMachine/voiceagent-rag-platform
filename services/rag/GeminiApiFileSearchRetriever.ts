import type { RagRetriever, RagRetrieverDocument, RagRetrieverResult, RagSearchParams } from './types';

type Options = {
  fetchImpl?: typeof fetch;
};

type GenerateContentResponse = {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        retrievedContext?: {
          title?: string;
          text?: string;
          uri?: string;
        };
        id?: string;
      }>;
    };
  }>;
};

/**
 * APIキーで Gemini File Search store を叩く軽量リトリーバー。
 * 生成テキストは捨て、groundingMetadata からスニペットを組み立てる。
 */
export class GeminiApiFileSearchRetriever implements RagRetriever {
  private readonly apiKey: string;
  private readonly storeName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(params: { apiKey: string; storeName: string }, options: Options = {}) {
    this.apiKey = params.apiKey;
    this.storeName = params.storeName;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(params: RagSearchParams): Promise<RagRetrieverResult> {
    const started = Date.now();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: params.query }] }],
      tools: [{ fileSearch: { fileSearchStoreNames: [this.storeName] } }],
      generationConfig: {
        temperature: 0,
        // 少なくとも groundingMetadata が返るだけの余裕を確保
        maxOutputTokens: 256,
      },
    };

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`Gemini File Search (API key) failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as GenerateContentResponse;
    const chunks = json.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

    const items: RagRetrieverDocument[] = chunks.map((chunk, idx) => ({
      id: chunk.id ?? `chunk-${idx + 1}`,
      title: chunk.retrievedContext?.title ?? undefined,
      snippet: chunk.retrievedContext?.text ?? undefined,
      uri: chunk.retrievedContext?.uri ?? undefined,
      metadata: {},
      score: undefined,
    }));

    return { items, tookMs: Date.now() - started };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
