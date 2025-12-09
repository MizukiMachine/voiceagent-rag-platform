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

  constructor(config: GeminiFileSearchConfig, options: GeminiFileSearchRetrieverOptions = {}) {
    this.config = config;
    this.auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      keyFile: config.serviceAccountKeyPath,
    });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.servingConfig = buildServingConfigResource(config);
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
    const response = await this.fetchImpl(url.toString(), {
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
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) {
      throw new Error('Failed to acquire access token for File Search');
    }
    return tokenResponse.token;
  }
}

function toRetrieverDocument(result: SearchResponse['results'][number]): RagRetrieverDocument {
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
  const candidates: Array<string | undefined> = [];

  if (Array.isArray(derived.snippets)) {
    candidates.push(derived.snippets[0]);
  }
  if (Array.isArray(struct.snippets)) {
    candidates.push(struct.snippets[0]);
  }
  if (Array.isArray(derived.extractive_answers)) {
    candidates.push(derived.extractive_answers[0]?.content);
  }
  if (Array.isArray(struct.extractive_answers)) {
    candidates.push(struct.extractive_answers[0]?.content);
  }
  if (typeof derived.content === 'string') {
    candidates.push(derived.content);
  }
  if (typeof struct.content === 'string') {
    candidates.push(struct.content);
  }
  const inline = document?.content?.inlineDocument?.content;
  if (typeof inline === 'string') {
    candidates.push(inline);
  }

  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
