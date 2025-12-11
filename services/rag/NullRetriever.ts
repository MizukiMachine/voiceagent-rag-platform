import type { RagRetriever, RagRetrieverResult, RagSearchParams } from './types';

/**
 * Placeholder retriever for environments where File Search is not configured yet.
 * It keeps DI wiring stable while allowing tests and other retrievers to plug in later.
 */
export class NullRetriever implements RagRetriever {
  async search(params: RagSearchParams): Promise<RagRetrieverResult> {
    throw new Error('Gemini File Search is not configured. Please set FILE_SEARCH_* env vars.');
  }
}
