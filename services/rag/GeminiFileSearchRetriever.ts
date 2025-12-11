import { GoogleAuth } from 'google-auth-library';

import type { RagRetriever, RagRetrieverDocument, RagRetrieverResult, RagSearchParams } from './types';
import { buildServingConfigResource, type GeminiFileSearchConfig } from './config';

type GeminiFileSearchRetrieverOptions = {
  fetchImpl?: typeof fetch;
};

type SearchResponse = {
  results?: Array<{
    id?: string;
    document?: {
      name?: string;
      id?: string;
      structData?: Record<string, any>;
      derivedStructData?: Record<string, any>;
      content?: {
        inlineDocument?: {
          mimeType?: string;
          content?: string;
        };
      };
    };
    documentMetadata?: Record<string, any>;
    score?: number;
  }>;
};

export class GeminiFileSearchRetriever implements RagRetriever {
  private readonly config: GeminiFileSearchConfig;
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly servingConfig: string;
  private tokenCache: { token: string; expiresAt: number } | null = null;
  private readonly requestTimeoutMs: number;

  constructor(config: GeminiFileSearchConfig, options: GeminiFileSearchRetrieverOptions = {}) {
    if (!config.serviceAccountKeyPath) {
      throw new Error(
        'Gemini File Search requires FILE_SEARCH_SA_KEY_PATH (or GOOGLE_APPLICATION_CREDENTIALS) to be set.',
      );
    }
    this.config = config;
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      keyFile: config.serviceAccountKeyPath,
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.servingConfig = buildServingConfigResource(config);
    this.requestTimeoutMs = Number(process.env.FILE_SEARCH_TIMEOUT_MS ?? '') || 15_000;
  }

  async search(params: RagSearchParams): Promise<RagRetrieverResult> {
    const pageSize = params.topK && params.topK > 0 ? params.topK : this.config.defaultTopK;
    const url = new URL(
      `https://${this.config.apiEndpoint}/${this.config.apiVersion}/${this.servingConfig}:search`,
    );

    const body: Record<string, any> = {
      query: params.query,
      pageSize,
      contentSearchSpec: {
        snippetSpec: {
          returnSnippet: true,
          maxSnippetCount: 2,
        },
        summarySpec: {
          summaryResultCount: 0,
        },
      },
      queryExpansionSpec: { condition: 'AUTO' },
      spellCorrectionSpec: { mode: 'AUTO' },
    };
    if (params.filter) {
      body.filter = params.filter;
    }

    const token = await this.getAccessToken();
    const started = Date.now();
    const response = await this.fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `Gemini File Search failed with status ${response.status}: ${text || response.statusText}`,
      );
    }

    const json = (await response.json()) as SearchResponse;
    const items = (json.results ?? []).map(toRetrieverDocument);
    const tookMs = Date.now() - started;

    return { items, tookMs };
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 5_000) {
      return this.tokenCache.token;
    }
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) {
      throw new Error('Failed to acquire access token for File Search');
    }
    const expiresInSec =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (tokenResponse as any)?.res?.data?.expires_in && Number((tokenResponse as any).res.data.expires_in);
    const ttlMs = Number.isFinite(expiresInSec) ? Math.max(0, expiresInSec * 1000 - 10_000) : 5 * 60 * 1000;
    this.tokenCache = { token: tokenResponse.token, expiresAt: now + ttlMs };
    return tokenResponse.token;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        throw new Error(`Gemini File Search request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function toRetrieverDocument(result: SearchResponse['results'][number]): RagRetrieverDocument {
  if (!result) {
    return { id: 'unknown', snippet: undefined };
  }
  const document = result?.document ?? {};
  const derived = document.derivedStructData ?? {};
  const struct = document.structData ?? {};
  const metadata = {
    ...(result?.documentMetadata ?? {}),
    ...('mimeType' in derived ? { mimeType: derived.mimeType } : {}),
  };

  return {
    id: document.id ?? result?.id ?? document.name ?? 'unknown',
    title: derived.title ?? struct.title,
    uri: derived.uri ?? struct.uri ?? metadata?.uri,
    snippet: pickSnippet(derived, struct, document),
    score: result?.score,
    metadata,
  };
}

function pickSnippet(
  derived: Record<string, any>,
  struct: Record<string, any>,
  document: SearchResponse['results'][number]['document'],
): string | undefined {
  if (!document) return undefined;

  const orderedCandidates: Array<string | undefined> = [
    Array.isArray(derived.snippets) ? derived.snippets[0] : undefined,
    Array.isArray(struct.snippets) ? struct.snippets[0] : undefined,
    Array.isArray(derived.extractive_answers) ? derived.extractive_answers[0]?.content : undefined,
    Array.isArray(struct.extractive_answers) ? struct.extractive_answers[0]?.content : undefined,
    typeof derived.content === 'string' ? derived.content : undefined,
    typeof struct.content === 'string' ? struct.content : undefined,
    typeof document?.content?.inlineDocument?.content === 'string'
      ? document.content.inlineDocument.content
      : undefined,
  ];

  return orderedCandidates.find((value) => typeof value === 'string' && value.trim().length > 0);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
