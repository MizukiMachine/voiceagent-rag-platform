import { createStructuredLogger, type StructuredLogger } from '../../framework/logging/structuredLogger';
import type { RagRetriever, RagSearchParams, RagSearchResult, RagSearchResultItem } from './types';

type RagServiceOptions = {
  retriever: RagRetriever;
  logger?: StructuredLogger;
};

export class RagService {
  private readonly retriever: RagRetriever;
  private readonly logger: StructuredLogger;

  constructor(options: RagServiceOptions) {
    this.retriever = options.retriever;
    this.logger =
      options.logger ??
      createStructuredLogger({
        component: 'rag',
      });
  }

  async searchDocuments(params: RagSearchParams & { scenarioKey?: string; clientTag?: string }): Promise<RagSearchResult> {
    const topK = params.topK && params.topK > 0 ? params.topK : 5;
    const started = Date.now();
    const result = await this.retriever.search({ ...params, topK });
    const tookMs = result.tookMs ?? Date.now() - started;

    const items: RagSearchResultItem[] = result.items.map((item, idx) => ({
      ...item,
      citeTag: `[FS-${idx + 1}]`,
      source: 'gemini_file_search',
      snippet: redactSensitiveText(sanitizeSnippet(item.snippet)),
      title: item.title ?? inferTitle(item),
    }));

    const summary = renderSummary(items);

    this.logger.info('rag.search.completed', {
      query: params.query,
      filter: params.filter ?? null,
      topK,
      hits: items.length,
      scenarioKey: params.scenarioKey ?? null,
      clientTag: params.clientTag ?? null,
      tookMs,
    });

    return {
      query: params.query,
      filter: params.filter,
      topK,
      tookMs,
      items,
      summary,
    };
  }
}

function sanitizeSnippet(snippet?: string): string | undefined {
  if (!snippet) return '';
  return snippet.replace(/\s+/g, ' ').replace(/\u0000/g, '').trim();
}

function inferTitle(item: { uri?: string; id?: string; metadata?: Record<string, any> }): string | undefined {
  if (item.metadata?.title && typeof item.metadata.title === 'string') {
    return item.metadata.title;
  }
  if (item.uri) {
    const parts = item.uri.split('/');
    const last = parts[parts.length - 1];
    return decodeURIComponent(last || item.uri);
  }
  if (item.id) return item.id;
  return undefined;
}

function renderSummary(items: RagSearchResultItem[]): string {
  if (items.length === 0) {
    return 'No supporting documents were found for this query.';
  }
  return items
    .map((item) => {
      const title = item.title ?? 'Untitled';
      const snippet = item.snippet ? truncate(snippetNormalize(item.snippet), 240) : '内容抜粋なし';
      return `${item.citeTag} ${title}: ${snippet}`;
    })
    .join('\n');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function snippetNormalize(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

function redactSensitiveText(input?: string): string | undefined {
  if (!input) return input;
  // 簡易的なPIIパターンを除去（メールアドレス・10桁以上の数字列）
  const redacted = input
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b\d{10,}\b/g, '[redacted-number]');
  return redacted;
}
